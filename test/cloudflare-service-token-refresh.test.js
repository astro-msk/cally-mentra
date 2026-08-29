const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const SCRIPT_PATH = path.resolve(__dirname, "../scripts/refresh-cloudflare-service-tokens.mjs");
const SCRIPT_URL = pathToFileURL(SCRIPT_PATH).href;
const ACCOUNT_ID = "a".repeat(32);
const FIRST_TOKEN_ID = "11111111-1111-1111-1111-111111111111";
const SECOND_TOKEN_ID = "22222222-2222-2222-2222-222222222222";
const API_TOKEN = "cloudflare-api-token-must-never-be-logged";

let modulePromise;
function loadScript() {
  modulePromise ??= import(SCRIPT_URL);
  return modulePromise;
}

function validEnv(overrides = {}) {
  return {
    CLOUDFLARE_API_TOKEN: API_TOKEN,
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
    CALLY_CLOUDFLARE_SERVICE_TOKEN_IDS: `${FIRST_TOKEN_ID},${SECOND_TOKEN_ID}`,
    ...overrides,
  };
}

function successfulResponse(tokenId, overrides = {}) {
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        success: true,
        result: {
          id: tokenId,
          name: `glasses-${tokenId.slice(0, 8)}`,
          expires_at: "2027-01-02T03:04:05Z",
          client_id: "must-not-be-returned",
          client_secret: "must-not-be-returned",
          ...overrides,
        },
      };
    },
  };
}

test("config parser validates account and UUIDs and deduplicates token ids", async () => {
  const { parseCloudflareServiceTokenRefreshConfig } = await loadScript();
  const config = parseCloudflareServiceTokenRefreshConfig(validEnv({
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID.toUpperCase(),
    CALLY_CLOUDFLARE_SERVICE_TOKEN_IDS:
      ` ${FIRST_TOKEN_ID.toUpperCase()} , ${SECOND_TOKEN_ID}, ${FIRST_TOKEN_ID} `,
  }));

  assert.equal(config.apiToken, API_TOKEN);
  assert.equal(config.accountId, ACCOUNT_ID);
  assert.deepEqual(config.serviceTokenIds, [FIRST_TOKEN_ID, SECOND_TOKEN_ID]);
});

test("config parser fails closed without exposing the API token", async () => {
  const { parseCloudflareServiceTokenRefreshConfig } = await loadScript();
  const invalidEnvironments = [
    { ...validEnv(), CLOUDFLARE_API_TOKEN: "" },
    { ...validEnv(), CLOUDFLARE_ACCOUNT_ID: "not-an-account-id" },
    { ...validEnv(), CALLY_CLOUDFLARE_SERVICE_TOKEN_IDS: "" },
    { ...validEnv(), CALLY_CLOUDFLARE_SERVICE_TOKEN_IDS: `${FIRST_TOKEN_ID},,${SECOND_TOKEN_ID}` },
    { ...validEnv(), CALLY_CLOUDFLARE_SERVICE_TOKEN_IDS: "not-a-uuid" },
  ];

  for (const env of invalidEnvironments) {
    let thrown;
    try {
      parseCloudflareServiceTokenRefreshConfig(env);
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof Error);
    assert.equal(thrown.message.includes(API_TOKEN), false);
  }
});

test("refresh uses only the official endpoint and returns a redacted result", async () => {
  const {
    parseCloudflareServiceTokenRefreshConfig,
    refreshCloudflareServiceToken,
  } = await loadScript();
  const config = parseCloudflareServiceTokenRefreshConfig(validEnv());
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return successfulResponse(FIRST_TOKEN_ID);
  };

  const result = await refreshCloudflareServiceToken(config, FIRST_TOKEN_ID, { fetchImpl });
  assert.deepEqual(result, {
    id: FIRST_TOKEN_ID,
    name: "glasses-11111111",
    expires_at: "2027-01-02T03:04:05Z",
  });
  assert.equal(Object.keys(result).length, 3);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}`
      + `/access/service_tokens/${FIRST_TOKEN_ID}/refresh`,
  );
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers.authorization, `Bearer ${API_TOKEN}`);
  assert.equal(calls[0].options.body, undefined);
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.equal(JSON.stringify(result).includes("must-not-be-returned"), false);
});

test("refresh validates HTTP, Cloudflare success, id, name, and expiration", async () => {
  const {
    CloudflareServiceTokenRefreshError,
    parseCloudflareServiceTokenRefreshConfig,
    refreshCloudflareServiceToken,
  } = await loadScript();
  const config = parseCloudflareServiceTokenRefreshConfig(validEnv());
  const responses = [
    { ok: false, status: 403, async json() { return { secret: API_TOKEN }; } },
    { ok: true, status: 200, async json() { return { success: false, errors: [{ message: API_TOKEN }] }; } },
    successfulResponse(SECOND_TOKEN_ID),
    successfulResponse(FIRST_TOKEN_ID, { name: "unsafe\nname" }),
    successfulResponse(FIRST_TOKEN_ID, { expires_at: "not-a-date" }),
  ];
  const expectedCodes = [
    "http_403",
    "api_rejected",
    "response_id_mismatch",
    "invalid_response_name",
    "invalid_response_expiry",
  ];

  for (let index = 0; index < responses.length; index += 1) {
    await assert.rejects(
      refreshCloudflareServiceToken(config, FIRST_TOKEN_ID, {
        fetchImpl: async () => responses[index],
      }),
      (error) => {
        assert.ok(error instanceof CloudflareServiceTokenRefreshError);
        assert.equal(error.code, expectedCodes[index]);
        assert.equal(error.message.includes(API_TOKEN), false);
        return true;
      },
    );
  }
});

test("refresh aborts a stalled request at the configured timeout", async () => {
  const {
    parseCloudflareServiceTokenRefreshConfig,
    refreshCloudflareServiceToken,
  } = await loadScript();
  const config = parseCloudflareServiceTokenRefreshConfig(validEnv());
  const fetchImpl = async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });

  await assert.rejects(
    refreshCloudflareServiceToken(config, FIRST_TOKEN_ID, {
      fetchImpl,
      timeoutMs: 250,
    }),
    (error) => error.code === "timeout",
  );
});

test("batch job attempts every token, logs only safe output, and fails deterministically", async () => {
  const {
    CloudflareServiceTokenRefreshBatchError,
    runCloudflareServiceTokenRefresh,
  } = await loadScript();
  const requestedIds = [];
  const stdout = [];
  const stderr = [];
  const fetchImpl = async (url) => {
    const tokenId = url.split("/").at(-2);
    requestedIds.push(tokenId);
    if (tokenId === FIRST_TOKEN_ID) {
      return { ok: false, status: 401, async json() { return { token: API_TOKEN }; } };
    }
    return successfulResponse(tokenId);
  };

  await assert.rejects(
    runCloudflareServiceTokenRefresh({
      env: validEnv(),
      fetchImpl,
      output: (line) => stdout.push(line),
      errorOutput: (line) => stderr.push(line),
    }),
    (error) => {
      assert.ok(error instanceof CloudflareServiceTokenRefreshBatchError);
      assert.deepEqual(error.failures, [{ tokenId: FIRST_TOKEN_ID, code: "http_401" }]);
      return true;
    },
  );

  assert.deepEqual(requestedIds, [FIRST_TOKEN_ID, SECOND_TOKEN_ID]);
  assert.equal(stdout.length, 1);
  assert.deepEqual(JSON.parse(stdout[0]), {
    id: SECOND_TOKEN_ID,
    name: "glasses-22222222",
    expires_at: "2027-01-02T03:04:05Z",
  });
  assert.equal(stderr.length, 1);
  const allOutput = JSON.stringify({ stdout, stderr });
  assert.equal(allOutput.includes(API_TOKEN), false);
  assert.equal(allOutput.includes("client_secret"), false);
});

test("main and direct CLI execution return a nonzero status on failure", async () => {
  const { main } = await loadScript();
  const stderr = [];
  const exitCode = await main({
    env: validEnv({ CLOUDFLARE_ACCOUNT_ID: "invalid" }),
    output: () => {},
    errorOutput: (line) => stderr.push(line),
  });
  assert.equal(exitCode, 1);
  assert.equal(JSON.stringify(stderr).includes(API_TOKEN), false);

  const childEnv = { ...process.env };
  childEnv.CLOUDFLARE_API_TOKEN = API_TOKEN;
  childEnv.CLOUDFLARE_ACCOUNT_ID = "invalid";
  childEnv.CALLY_CLOUDFLARE_SERVICE_TOKEN_IDS = FIRST_TOKEN_ID;
  const child = spawnSync(process.execPath, [SCRIPT_PATH], {
    encoding: "utf8",
    env: childEnv,
  });
  assert.equal(child.status, 1);
  assert.equal(child.stdout.includes(API_TOKEN), false);
  assert.equal(child.stderr.includes(API_TOKEN), false);
});
