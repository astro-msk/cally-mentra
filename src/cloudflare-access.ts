import type { IncomingMessage } from "node:http";
import type {
  DirectGlassesAuthIdentity,
  DirectGlassesUpgradeAuthenticator,
} from "./direct-glasses";

export const CLOUDFLARE_ACCESS_ASSERTION_HEADER = "cf-access-jwt-assertion";
export const CLOUDFLARE_ACCESS_ISSUER_ENV = "CALLY_CLOUDFLARE_ACCESS_ISSUER";
export const CLOUDFLARE_ACCESS_AUDIENCE_ENV = "CALLY_CLOUDFLARE_ACCESS_AUDIENCE";
export const CLOUDFLARE_ACCESS_DEVICE_BINDINGS_ENV =
  "CALLY_CLOUDFLARE_ACCESS_DEVICE_BINDINGS_JSON";

const CLOUDFLARE_ACCESS_CERTS_PATH = "/cdn-cgi/access/certs";
const MAX_AUDIENCE_CHARS = 512;
const MAX_COMMON_NAME_CHARS = 256;
const MAX_DEVICE_ID_CHARS = 128;
const MAX_ASSERTION_CHARS = 16 * 1024;

/** Validated Cloudflare Access settings for the direct-glasses upgrade path. */
export type CloudflareAccessConfig = {
  issuer: string;
  audience: string;
  jwksUrl: string;
  deviceBindings: ReadonlyMap<string, string>;
};

/** The subset of a verified JWT result used by the upgrade authenticator. */
export type CloudflareAccessVerifiedJwt = {
  protectedHeader: Record<string, unknown>;
  payload: Record<string, unknown>;
};

/** Injectable seam used by tests while production uses jose's remote JWKS verifier. */
export type CloudflareAccessJwtVerifier = (
  assertion: string,
) => Promise<CloudflareAccessVerifiedJwt>;

export type CloudflareAccessAuthenticatorDependencies = {
  verifyJwt?: CloudflareAccessJwtVerifier;
  nowMs?: () => number;
};

/**
 * Parse Cloudflare Access configuration from the environment.
 *
 * All three settings are optional as a group so local development can use the
 * explicit development-token fallback. A partial or unsafe configuration is a
 * startup error rather than silently weakening authentication.
 */
export function cloudflareAccessConfigFromEnv(
  env: NodeJS.ProcessEnv,
): CloudflareAccessConfig | undefined {
  const rawIssuer = normalizeEnv(env[CLOUDFLARE_ACCESS_ISSUER_ENV]);
  const audience = normalizeEnv(env[CLOUDFLARE_ACCESS_AUDIENCE_ENV]);
  const rawBindings = normalizeEnv(env[CLOUDFLARE_ACCESS_DEVICE_BINDINGS_ENV]);

  if (!rawIssuer && !audience && !rawBindings) return undefined;

  const missing = [
    [CLOUDFLARE_ACCESS_ISSUER_ENV, rawIssuer],
    [CLOUDFLARE_ACCESS_AUDIENCE_ENV, audience],
    [CLOUDFLARE_ACCESS_DEVICE_BINDINGS_ENV, rawBindings],
  ].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`Cloudflare Access configuration is incomplete; missing ${missing.join(", ")}`);
  }

  const issuer = parseIssuer(rawIssuer);
  validateAudience(audience);
  const deviceBindings = parseDeviceBindings(rawBindings);

  return {
    issuer,
    audience,
    jwksUrl: new URL(CLOUDFLARE_ACCESS_CERTS_PATH, `${issuer}/`).toString(),
    deviceBindings,
  };
}

/**
 * Create the production JWT verifier backed by Cloudflare's remotely rotated
 * JWKS. jose caches successful key lookups and rate-limits refresh attempts.
 */
export function createJoseCloudflareAccessJwtVerifier(
  config: CloudflareAccessConfig,
): CloudflareAccessJwtVerifier {
  // jose v6 is ESM-only while this application currently emits CommonJS. A
  // native dynamic import preserves that boundary without downgrading jose.
  const verifierPromise = import("jose").then((jose) => {
    const remoteJwks = jose.createRemoteJWKSet(new URL(config.jwksUrl));
    return async (assertion: string): Promise<CloudflareAccessVerifiedJwt> => {
      const verified = await jose.jwtVerify(assertion, remoteJwks, {
        algorithms: ["RS256"],
        issuer: config.issuer,
        audience: config.audience,
        requiredClaims: ["exp", "iss", "aud", "common_name"],
      });
      return {
        protectedHeader: verified.protectedHeader,
        payload: verified.payload,
      };
    };
  });

  return async (assertion) => (await verifierPromise)(assertion);
}

/**
 * Authenticate a WebSocket upgrade with Cloudflare Access and bind its service
 * token common name to exactly one configured glasses device id.
 */
export function createCloudflareAccessUpgradeAuthenticator(
  config: CloudflareAccessConfig,
  dependencies: CloudflareAccessAuthenticatorDependencies = {},
): DirectGlassesUpgradeAuthenticator {
  const verifyJwt = dependencies.verifyJwt ?? createJoseCloudflareAccessJwtVerifier(config);
  const nowMs = dependencies.nowMs ?? Date.now;

  return async (request: IncomingMessage): Promise<DirectGlassesAuthIdentity | undefined> => {
    const assertion = readAssertion(request);
    if (!assertion) return undefined;

    try {
      const verified = await verifyJwt(assertion);
      if (verified.protectedHeader.alg !== "RS256") return undefined;

      const payload = verified.payload;
      if (payload.iss !== config.issuer) return undefined;
      if (!audienceContains(payload.aud, config.audience)) return undefined;

      const expiresAtSeconds = payload.exp;
      if (!isPositiveSafeInteger(expiresAtSeconds)) return undefined;
      const expiresAtMs = expiresAtSeconds * 1000;
      if (expiresAtMs <= nowMs()) return undefined;

      const commonName = payload.common_name;
      if (typeof commonName !== "string" || !commonName || commonName !== commonName.trim()) {
        return undefined;
      }
      const allowedDeviceId = config.deviceBindings.get(commonName);
      if (!allowedDeviceId) return undefined;

      return {
        kind: "cloudflare_access",
        principalId: commonName,
        allowedDeviceId,
        expiresAtMs,
      };
    } catch {
      // Upgrade callers receive one generic unauthorized result. In particular,
      // never include a credential or jose error detail in authentication logs.
      return undefined;
    }
  };
}

function readAssertion(request: IncomingMessage): string | undefined {
  const raw = request.headers[CLOUDFLARE_ACCESS_ASSERTION_HEADER];
  if (typeof raw !== "string") return undefined;
  if (raw.length === 0 || raw.length > MAX_ASSERTION_CHARS || raw !== raw.trim()) {
    return undefined;
  }
  return raw;
}

function parseIssuer(rawIssuer: string): string {
  let issuerUrl: URL;
  try {
    issuerUrl = new URL(rawIssuer);
  } catch {
    throw new Error(`${CLOUDFLARE_ACCESS_ISSUER_ENV} must be an absolute HTTPS URL`);
  }

  const hostname = issuerUrl.hostname.toLowerCase();
  if (issuerUrl.protocol !== "https:"
      || issuerUrl.username
      || issuerUrl.password
      || issuerUrl.port
      || issuerUrl.search
      || issuerUrl.hash
      || (issuerUrl.pathname !== "/" && issuerUrl.pathname !== "")
      || !hostname.endsWith(".cloudflareaccess.com")
      || hostname === "cloudflareaccess.com") {
    throw new Error(
      `${CLOUDFLARE_ACCESS_ISSUER_ENV} must be a Cloudflare Access HTTPS origin`,
    );
  }
  return issuerUrl.origin;
}

function validateAudience(audience: string): void {
  if (!audience
      || audience.length > MAX_AUDIENCE_CHARS
      || audience !== audience.trim()
      || /\s/.test(audience)) {
    throw new Error(`${CLOUDFLARE_ACCESS_AUDIENCE_ENV} must be one non-empty audience tag`);
  }
}

function parseDeviceBindings(rawBindings: string): ReadonlyMap<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBindings);
  } catch {
    throw new Error(`${CLOUDFLARE_ACCESS_DEVICE_BINDINGS_ENV} must be valid JSON`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error(
      `${CLOUDFLARE_ACCESS_DEVICE_BINDINGS_ENV} must be a JSON object of common names to device ids`,
    );
  }

  const bindings = new Map<string, string>();
  for (const [commonName, deviceId] of Object.entries(parsed)) {
    if (commonName.length === 0
        || commonName.length > MAX_COMMON_NAME_CHARS
        || commonName !== commonName.trim()
        || hasControlCharacter(commonName)) {
      throw new Error(
        `${CLOUDFLARE_ACCESS_DEVICE_BINDINGS_ENV} contains an invalid common name`,
      );
    }
    if (typeof deviceId !== "string"
        || deviceId.length === 0
        || deviceId.length > MAX_DEVICE_ID_CHARS
        || deviceId !== deviceId.trim()
        || hasControlCharacter(deviceId)) {
      throw new Error(
        `${CLOUDFLARE_ACCESS_DEVICE_BINDINGS_ENV} contains an invalid device id`,
      );
    }
    bindings.set(commonName, deviceId);
  }
  if (bindings.size === 0) {
    throw new Error(`${CLOUDFLARE_ACCESS_DEVICE_BINDINGS_ENV} must not be empty`);
  }
  return bindings;
}

function audienceContains(rawAudience: unknown, expectedAudience: string): boolean {
  if (typeof rawAudience === "string") return rawAudience === expectedAudience;
  return Array.isArray(rawAudience)
    && rawAudience.length > 0
    && rawAudience.every((audience) => typeof audience === "string")
    && rawAudience.includes(expectedAudience);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value > 0
    && value <= Math.floor(Number.MAX_SAFE_INTEGER / 1000);
}

function normalizeEnv(value: string | undefined): string {
  return value == null ? "" : value.trim();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasControlCharacter(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}
