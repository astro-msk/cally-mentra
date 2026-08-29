#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";
const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 250;
const MAX_TIMEOUT_MS = 60_000;
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_SAFE_NAME_CHARS = 256;

export class CloudflareServiceTokenRefreshError extends Error {
  constructor(tokenId, code) {
    super(`Cloudflare service token ${tokenId} refresh failed (${code})`);
    this.name = "CloudflareServiceTokenRefreshError";
    this.tokenId = tokenId;
    this.code = code;
  }
}

export class CloudflareServiceTokenRefreshBatchError extends Error {
  constructor(failures) {
    super(`${failures.length} Cloudflare service token refresh operation(s) failed`);
    this.name = "CloudflareServiceTokenRefreshBatchError";
    this.failures = failures.map(({ tokenId, code }) => ({ tokenId, code }));
  }
}

/** Parse and validate the one-shot job's required environment. */
export function parseCloudflareServiceTokenRefreshConfig(env) {
  const apiToken = requiredSecret(env.CLOUDFLARE_API_TOKEN, "CLOUDFLARE_API_TOKEN");
  const accountId = requiredValue(env.CLOUDFLARE_ACCOUNT_ID, "CLOUDFLARE_ACCOUNT_ID");
  if (!ACCOUNT_ID_PATTERN.test(accountId)) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID must be exactly 32 hexadecimal characters");
  }

  const rawIds = requiredValue(
    env.CALLY_CLOUDFLARE_SERVICE_TOKEN_IDS,
    "CALLY_CLOUDFLARE_SERVICE_TOKEN_IDS",
  );
  const splitIds = rawIds.split(",");
  if (splitIds.some((id) => id.trim().length === 0)) {
    throw new Error("CALLY_CLOUDFLARE_SERVICE_TOKEN_IDS contains an empty entry");
  }

  const serviceTokenIds = [];
  const seen = new Set();
  for (const rawId of splitIds) {
    const tokenId = rawId.trim().toLowerCase();
    if (!UUID_PATTERN.test(tokenId)) {
      throw new Error("CALLY_CLOUDFLARE_SERVICE_TOKEN_IDS must contain only UUIDs");
    }
    if (!seen.has(tokenId)) {
      seen.add(tokenId);
      serviceTokenIds.push(tokenId);
    }
  }

  return Object.freeze({
    apiToken,
    accountId: accountId.toLowerCase(),
    serviceTokenIds: Object.freeze(serviceTokenIds),
  });
}

/**
 * Refresh one service token's expiration through Cloudflare's official API.
 *
 * The caller's API token should have only Account / Access: Service Tokens / Edit
 * permission for the configured account. The returned object deliberately drops
 * every response field except the safe identifier, name, and expiration.
 */
export async function refreshCloudflareServiceToken(
  config,
  tokenId,
  { fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {},
) {
  if (typeof fetchImpl !== "function") {
    throw new CloudflareServiceTokenRefreshError(tokenId, "fetch_unavailable");
  }
  const boundedTimeoutMs = validateTimeout(timeoutMs);
  const url = `${CLOUDFLARE_API_BASE}/accounts/${config.accountId}`
    + `/access/service_tokens/${tokenId}/refresh`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), boundedTimeoutMs);

  try {
    let response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${config.apiToken}`,
        },
        signal: controller.signal,
      });
    } catch {
      throw new CloudflareServiceTokenRefreshError(
        tokenId,
        controller.signal.aborted ? "timeout" : "network_error",
      );
    }

    if (!response || typeof response.ok !== "boolean") {
      throw new CloudflareServiceTokenRefreshError(tokenId, "invalid_http_response");
    }
    if (!response.ok) {
      const status = Number.isInteger(response.status) ? response.status : "unknown";
      throw new CloudflareServiceTokenRefreshError(tokenId, `http_${status}`);
    }

    let envelope;
    try {
      envelope = await response.json();
    } catch {
      throw new CloudflareServiceTokenRefreshError(tokenId, "invalid_json");
    }
    return parseSuccessfulRefreshEnvelope(envelope, tokenId);
  } finally {
    clearTimeout(timeout);
  }
}

/** Refresh every configured token, log safe summaries, and aggregate failures. */
export async function runCloudflareServiceTokenRefresh({
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  output = (line) => console.log(line),
  errorOutput = (line) => console.error(line),
} = {}) {
  const config = parseCloudflareServiceTokenRefreshConfig(env);
  const results = [];
  const failures = [];

  // Keep scheduler logs and API load deterministic by refreshing sequentially.
  for (const tokenId of config.serviceTokenIds) {
    try {
      const result = await refreshCloudflareServiceToken(config, tokenId, {
        fetchImpl,
        timeoutMs,
      });
      results.push(result);
      output(JSON.stringify(result));
    } catch (error) {
      const safeError = normalizeRefreshError(error, tokenId);
      failures.push({ tokenId: safeError.tokenId, code: safeError.code });
      errorOutput(safeError.message);
    }
  }

  if (failures.length > 0) {
    throw new CloudflareServiceTokenRefreshBatchError(failures);
  }
  return results;
}

/** Run the scheduler job and return the desired process exit code. */
export async function main(options = {}) {
  const errorOutput = options.errorOutput ?? ((line) => console.error(line));
  try {
    await runCloudflareServiceTokenRefresh({ ...options, errorOutput });
    return 0;
  } catch (error) {
    if (error instanceof CloudflareServiceTokenRefreshBatchError) {
      errorOutput(error.message);
    } else {
      // Configuration messages contain environment names, never their values.
      const message = error instanceof Error ? error.message : "unknown failure";
      errorOutput(`Cloudflare service-token refresh job failed: ${message}`);
    }
    return 1;
  }
}

function parseSuccessfulRefreshEnvelope(envelope, requestedTokenId) {
  if (!isPlainObject(envelope) || envelope.success !== true || !isPlainObject(envelope.result)) {
    throw new CloudflareServiceTokenRefreshError(requestedTokenId, "api_rejected");
  }

  const { id, name, expires_at: expiresAt } = envelope.result;
  if (typeof id !== "string" || id.toLowerCase() !== requestedTokenId.toLowerCase()) {
    throw new CloudflareServiceTokenRefreshError(requestedTokenId, "response_id_mismatch");
  }
  if (typeof name !== "string"
      || name.length === 0
      || name.length > MAX_SAFE_NAME_CHARS
      || hasControlCharacter(name)) {
    throw new CloudflareServiceTokenRefreshError(requestedTokenId, "invalid_response_name");
  }
  if (typeof expiresAt !== "string" || !isIsoDate(expiresAt)) {
    throw new CloudflareServiceTokenRefreshError(requestedTokenId, "invalid_response_expiry");
  }

  return Object.freeze({
    id: requestedTokenId,
    name,
    expires_at: expiresAt,
  });
}

function normalizeRefreshError(error, tokenId) {
  if (error instanceof CloudflareServiceTokenRefreshError) return error;
  return new CloudflareServiceTokenRefreshError(tokenId, "unexpected_error");
}

function validateTimeout(timeoutMs) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`timeoutMs must be an integer from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS}`);
  }
  return timeoutMs;
}

function requiredSecret(raw, name) {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  return raw.trim();
}

function requiredValue(raw, name) {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  return raw.trim();
}

function isIsoDate(value) {
  return RFC3339_PATTERN.test(value) && Number.isFinite(Date.parse(value));
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasControlCharacter(value) {
  return /[\u0000-\u001f\u007f]/.test(value);
}

const isDirectExecution = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectExecution) {
  process.exitCode = await main();
}
