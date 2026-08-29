const assert = require("node:assert/strict");
const test = require("node:test");

const {
  CLOUDFLARE_ACCESS_ASSERTION_HEADER,
  CLOUDFLARE_ACCESS_AUDIENCE_ENV,
  CLOUDFLARE_ACCESS_DEVICE_BINDINGS_ENV,
  CLOUDFLARE_ACCESS_ISSUER_ENV,
  cloudflareAccessConfigFromEnv,
  createCloudflareAccessUpgradeAuthenticator,
} = require("../dist/cloudflare-access");

const ISSUER = "https://cally.cloudflareaccess.com";
const AUDIENCE = "0123456789abcdef0123456789abcdef";
const COMMON_NAME = "mentra-live-service-token";
const DEVICE_ID = "mentra-live-001";
const NOW_MS = 1_800_000_000_000;

function configuredEnv(overrides = {}) {
  return {
    [CLOUDFLARE_ACCESS_ISSUER_ENV]: ISSUER,
    [CLOUDFLARE_ACCESS_AUDIENCE_ENV]: AUDIENCE,
    [CLOUDFLARE_ACCESS_DEVICE_BINDINGS_ENV]: JSON.stringify({
      [COMMON_NAME]: DEVICE_ID,
    }),
    ...overrides,
  };
}

function configured() {
  const config = cloudflareAccessConfigFromEnv(configuredEnv());
  assert.ok(config);
  return config;
}

function upgradeRequest(assertion = "header.payload.signature") {
  return {
    headers: {
      [CLOUDFLARE_ACCESS_ASSERTION_HEADER]: assertion,
    },
  };
}

function verifiedJwt(overrides = {}) {
  return {
    protectedHeader: { alg: "RS256", kid: "cloudflare-key" },
    payload: {
      iss: ISSUER,
      aud: AUDIENCE,
      exp: Math.floor(NOW_MS / 1000) + 300,
      common_name: COMMON_NAME,
      ...overrides,
    },
  };
}

test("Cloudflare Access config is disabled only when every setting is absent", () => {
  assert.equal(cloudflareAccessConfigFromEnv({}), undefined);
  assert.throws(
    () => cloudflareAccessConfigFromEnv({
      [CLOUDFLARE_ACCESS_ISSUER_ENV]: ISSUER,
    }),
    /configuration is incomplete/,
  );
});

test("Cloudflare Access config derives the remote JWKS URL and device binding", () => {
  const config = cloudflareAccessConfigFromEnv(configuredEnv({
    [CLOUDFLARE_ACCESS_ISSUER_ENV]: `${ISSUER}/`,
  }));
  assert.ok(config);
  assert.equal(config.issuer, ISSUER);
  assert.equal(config.audience, AUDIENCE);
  assert.equal(config.jwksUrl, `${ISSUER}/cdn-cgi/access/certs`);
  assert.equal(config.deviceBindings.get(COMMON_NAME), DEVICE_ID);
});

test("Cloudflare Access config rejects unsafe issuers and malformed bindings", () => {
  const invalidEnvironments = [
    configuredEnv({ [CLOUDFLARE_ACCESS_ISSUER_ENV]: "http://cally.cloudflareaccess.com" }),
    configuredEnv({ [CLOUDFLARE_ACCESS_ISSUER_ENV]: "https://example.com" }),
    configuredEnv({ [CLOUDFLARE_ACCESS_ISSUER_ENV]: "https://cally.cloudflareaccess.com:8443" }),
    configuredEnv({ [CLOUDFLARE_ACCESS_ISSUER_ENV]: `${ISSUER}/unexpected` }),
    configuredEnv({ [CLOUDFLARE_ACCESS_AUDIENCE_ENV]: "audience with whitespace" }),
    configuredEnv({ [CLOUDFLARE_ACCESS_DEVICE_BINDINGS_ENV]: "not-json" }),
    configuredEnv({ [CLOUDFLARE_ACCESS_DEVICE_BINDINGS_ENV]: "[]" }),
    configuredEnv({ [CLOUDFLARE_ACCESS_DEVICE_BINDINGS_ENV]: "{}" }),
    configuredEnv({
      [CLOUDFLARE_ACCESS_DEVICE_BINDINGS_ENV]: JSON.stringify({ [COMMON_NAME]: "" }),
    }),
  ];
  for (const env of invalidEnvironments) {
    assert.throws(() => cloudflareAccessConfigFromEnv(env));
  }
});

test("upgrade authenticator returns the device identity bound to common_name", async () => {
  const assertions = [];
  const authenticate = createCloudflareAccessUpgradeAuthenticator(configured(), {
    nowMs: () => NOW_MS,
    verifyJwt: async (assertion) => {
      assertions.push(assertion);
      return verifiedJwt({ aud: ["another-audience", AUDIENCE] });
    },
  });

  const identity = await authenticate(upgradeRequest("signed-access-jwt"));
  assert.deepEqual(assertions, ["signed-access-jwt"]);
  assert.deepEqual(identity, {
    kind: "cloudflare_access",
    principalId: COMMON_NAME,
    allowedDeviceId: DEVICE_ID,
    expiresAtMs: NOW_MS + 300_000,
  });
});

test("upgrade authenticator rejects missing or ambiguous assertion headers before verification", async () => {
  let verificationCalls = 0;
  const authenticate = createCloudflareAccessUpgradeAuthenticator(configured(), {
    nowMs: () => NOW_MS,
    verifyJwt: async () => {
      verificationCalls += 1;
      return verifiedJwt();
    },
  });

  assert.equal(await authenticate({ headers: {} }), undefined);
  assert.equal(await authenticate({
    headers: { [CLOUDFLARE_ACCESS_ASSERTION_HEADER]: ["one", "two"] },
  }), undefined);
  assert.equal(await authenticate(upgradeRequest(" padded.jwt.value ")), undefined);
  assert.equal(verificationCalls, 0);
});

test("upgrade authenticator fails closed when JWT verification fails", async () => {
  const authenticate = createCloudflareAccessUpgradeAuthenticator(configured(), {
    nowMs: () => NOW_MS,
    verifyJwt: async () => {
      throw new Error("signature rejected");
    },
  });
  assert.equal(await authenticate(upgradeRequest()), undefined);
});

test("upgrade authenticator enforces algorithm, issuer, audience, expiry, and device binding", async () => {
  const invalidResults = [
    { ...verifiedJwt(), protectedHeader: { alg: "HS256" } },
    verifiedJwt({ iss: "https://other.cloudflareaccess.com" }),
    verifiedJwt({ aud: "wrong-audience" }),
    verifiedJwt({ aud: [AUDIENCE, 42] }),
    verifiedJwt({ exp: undefined }),
    verifiedJwt({ exp: Math.floor(NOW_MS / 1000) }),
    verifiedJwt({ exp: Math.floor(NOW_MS / 1000) + 0.5 }),
    verifiedJwt({ common_name: undefined }),
    verifiedJwt({ common_name: "unmapped-service-token" }),
  ];

  for (const result of invalidResults) {
    const authenticate = createCloudflareAccessUpgradeAuthenticator(configured(), {
      nowMs: () => NOW_MS,
      verifyJwt: async () => result,
    });
    assert.equal(await authenticate(upgradeRequest()), undefined);
  }
});
