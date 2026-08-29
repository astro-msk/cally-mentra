"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CLOUDFLARE_ACCESS_DEVICE_BINDINGS_ENV = exports.CLOUDFLARE_ACCESS_AUDIENCE_ENV = exports.CLOUDFLARE_ACCESS_ISSUER_ENV = exports.CLOUDFLARE_ACCESS_ASSERTION_HEADER = void 0;
exports.cloudflareAccessConfigFromEnv = cloudflareAccessConfigFromEnv;
exports.createJoseCloudflareAccessJwtVerifier = createJoseCloudflareAccessJwtVerifier;
exports.createCloudflareAccessUpgradeAuthenticator = createCloudflareAccessUpgradeAuthenticator;
exports.CLOUDFLARE_ACCESS_ASSERTION_HEADER = "cf-access-jwt-assertion";
exports.CLOUDFLARE_ACCESS_ISSUER_ENV = "CALLY_CLOUDFLARE_ACCESS_ISSUER";
exports.CLOUDFLARE_ACCESS_AUDIENCE_ENV = "CALLY_CLOUDFLARE_ACCESS_AUDIENCE";
exports.CLOUDFLARE_ACCESS_DEVICE_BINDINGS_ENV = "CALLY_CLOUDFLARE_ACCESS_DEVICE_BINDINGS_JSON";
const CLOUDFLARE_ACCESS_CERTS_PATH = "/cdn-cgi/access/certs";
const MAX_AUDIENCE_CHARS = 512;
const MAX_COMMON_NAME_CHARS = 256;
const MAX_DEVICE_ID_CHARS = 128;
const MAX_ASSERTION_CHARS = 16 * 1024;
/**
 * Parse Cloudflare Access configuration from the environment.
 *
 * All three settings are optional as a group so local development can use the
 * explicit development-token fallback. A partial or unsafe configuration is a
 * startup error rather than silently weakening authentication.
 */
function cloudflareAccessConfigFromEnv(env) {
    const rawIssuer = normalizeEnv(env[exports.CLOUDFLARE_ACCESS_ISSUER_ENV]);
    const audience = normalizeEnv(env[exports.CLOUDFLARE_ACCESS_AUDIENCE_ENV]);
    const rawBindings = normalizeEnv(env[exports.CLOUDFLARE_ACCESS_DEVICE_BINDINGS_ENV]);
    if (!rawIssuer && !audience && !rawBindings)
        return undefined;
    const missing = [
        [exports.CLOUDFLARE_ACCESS_ISSUER_ENV, rawIssuer],
        [exports.CLOUDFLARE_ACCESS_AUDIENCE_ENV, audience],
        [exports.CLOUDFLARE_ACCESS_DEVICE_BINDINGS_ENV, rawBindings],
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
function createJoseCloudflareAccessJwtVerifier(config) {
    // jose v6 is ESM-only while this application currently emits CommonJS. A
    // native dynamic import preserves that boundary without downgrading jose.
    const verifierPromise = import("jose").then((jose) => {
        const remoteJwks = jose.createRemoteJWKSet(new URL(config.jwksUrl));
        return async (assertion) => {
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
function createCloudflareAccessUpgradeAuthenticator(config, dependencies = {}) {
    const verifyJwt = dependencies.verifyJwt ?? createJoseCloudflareAccessJwtVerifier(config);
    const nowMs = dependencies.nowMs ?? Date.now;
    return async (request) => {
        const assertion = readAssertion(request);
        if (!assertion)
            return undefined;
        try {
            const verified = await verifyJwt(assertion);
            if (verified.protectedHeader.alg !== "RS256")
                return undefined;
            const payload = verified.payload;
            if (payload.iss !== config.issuer)
                return undefined;
            if (!audienceContains(payload.aud, config.audience))
                return undefined;
            const expiresAtSeconds = payload.exp;
            if (!isPositiveSafeInteger(expiresAtSeconds))
                return undefined;
            const expiresAtMs = expiresAtSeconds * 1000;
            if (expiresAtMs <= nowMs())
                return undefined;
            const commonName = payload.common_name;
            if (typeof commonName !== "string" || !commonName || commonName !== commonName.trim()) {
                return undefined;
            }
            const allowedDeviceId = config.deviceBindings.get(commonName);
            if (!allowedDeviceId)
                return undefined;
            return {
                kind: "cloudflare_access",
                principalId: commonName,
                allowedDeviceId,
                expiresAtMs,
            };
        }
        catch {
            // Upgrade callers receive one generic unauthorized result. In particular,
            // never include a credential or jose error detail in authentication logs.
            return undefined;
        }
    };
}
function readAssertion(request) {
    const raw = request.headers[exports.CLOUDFLARE_ACCESS_ASSERTION_HEADER];
    if (typeof raw !== "string")
        return undefined;
    if (raw.length === 0 || raw.length > MAX_ASSERTION_CHARS || raw !== raw.trim()) {
        return undefined;
    }
    return raw;
}
function parseIssuer(rawIssuer) {
    let issuerUrl;
    try {
        issuerUrl = new URL(rawIssuer);
    }
    catch {
        throw new Error(`${exports.CLOUDFLARE_ACCESS_ISSUER_ENV} must be an absolute HTTPS URL`);
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
        throw new Error(`${exports.CLOUDFLARE_ACCESS_ISSUER_ENV} must be a Cloudflare Access HTTPS origin`);
    }
    return issuerUrl.origin;
}
function validateAudience(audience) {
    if (!audience
        || audience.length > MAX_AUDIENCE_CHARS
        || audience !== audience.trim()
        || /\s/.test(audience)) {
        throw new Error(`${exports.CLOUDFLARE_ACCESS_AUDIENCE_ENV} must be one non-empty audience tag`);
    }
}
function parseDeviceBindings(rawBindings) {
    let parsed;
    try {
        parsed = JSON.parse(rawBindings);
    }
    catch {
        throw new Error(`${exports.CLOUDFLARE_ACCESS_DEVICE_BINDINGS_ENV} must be valid JSON`);
    }
    if (!isPlainObject(parsed)) {
        throw new Error(`${exports.CLOUDFLARE_ACCESS_DEVICE_BINDINGS_ENV} must be a JSON object of common names to device ids`);
    }
    const bindings = new Map();
    for (const [commonName, deviceId] of Object.entries(parsed)) {
        if (commonName.length === 0
            || commonName.length > MAX_COMMON_NAME_CHARS
            || commonName !== commonName.trim()
            || hasControlCharacter(commonName)) {
            throw new Error(`${exports.CLOUDFLARE_ACCESS_DEVICE_BINDINGS_ENV} contains an invalid common name`);
        }
        if (typeof deviceId !== "string"
            || deviceId.length === 0
            || deviceId.length > MAX_DEVICE_ID_CHARS
            || deviceId !== deviceId.trim()
            || hasControlCharacter(deviceId)) {
            throw new Error(`${exports.CLOUDFLARE_ACCESS_DEVICE_BINDINGS_ENV} contains an invalid device id`);
        }
        bindings.set(commonName, deviceId);
    }
    if (bindings.size === 0) {
        throw new Error(`${exports.CLOUDFLARE_ACCESS_DEVICE_BINDINGS_ENV} must not be empty`);
    }
    return bindings;
}
function audienceContains(rawAudience, expectedAudience) {
    if (typeof rawAudience === "string")
        return rawAudience === expectedAudience;
    return Array.isArray(rawAudience)
        && rawAudience.length > 0
        && rawAudience.every((audience) => typeof audience === "string")
        && rawAudience.includes(expectedAudience);
}
function isPositiveSafeInteger(value) {
    return typeof value === "number"
        && Number.isSafeInteger(value)
        && value > 0
        && value <= Math.floor(Number.MAX_SAFE_INTEGER / 1000);
}
function normalizeEnv(value) {
    return value == null ? "" : value.trim();
}
function isPlainObject(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
function hasControlCharacter(value) {
    return /[\u0000-\u001f\u007f]/.test(value);
}
