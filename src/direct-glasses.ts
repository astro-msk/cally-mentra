import { randomUUID, timingSafeEqual } from "node:crypto";
import type { Express, Request, Response } from "express";
import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { z } from "zod";

export const DIRECT_GLASSES_PATH = "/v1/glasses/connect";

const DEFAULT_MAX_PAYLOAD_BYTES = 16 * 1024;
const DEFAULT_HELLO_TIMEOUT_MS = 10_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 45_000;
const MIN_HEARTBEAT_TIMEOUT_MS = 45_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_SWEEP_INTERVAL_MS = 1_000;
const DEFAULT_MAX_PENDING_REQUESTS = 16;

const requestIdSchema = z.string().min(1).max(128);
const timestampSchema = z.number().int().nonnegative();
const emptyPayloadSchema = z.object({}).strict().optional().default({});

const deviceStatusSchema = z.object({
  battery: z.number().min(-1).max(100).nullable().optional(),
  charging: z.boolean().nullable().optional(),
  wifiConnected: z.boolean().nullable().optional(),
  wifiSsid: z.string().max(128).nullable().optional(),
  wifiRssi: z.number().int().min(-127).max(0).nullable().optional(),
  localIp: z.string().max(64).nullable().optional(),
}).strict();

const helloPayloadSchema = z.object({
  protocolVersion: z.literal(1),
  deviceId: z.string().trim().min(1).max(128),
  processSid: z.string().trim().min(1).max(64).optional(),
  deviceModel: z.string().max(128).optional(),
  androidVersion: z.string().max(64).optional(),
  androidSdk: z.number().int().nonnegative().optional(),
  appVersion: z.string().max(128).optional(),
}).strict();

const helloMessageSchema = z.object({
  type: z.literal("hello"),
  requestId: requestIdSchema.optional(),
  timestamp: timestampSchema,
  payload: helloPayloadSchema,
}).strict();

const heartbeatMessageSchema = z.object({
  type: z.literal("heartbeat"),
  requestId: requestIdSchema.optional(),
  timestamp: timestampSchema,
  payload: deviceStatusSchema,
}).strict();

const pingMessageSchema = z.object({
  type: z.literal("ping"),
  requestId: requestIdSchema.optional(),
  timestamp: timestampSchema,
  payload: emptyPayloadSchema,
}).strict();

const pongMessageSchema = z.object({
  type: z.literal("pong"),
  requestId: requestIdSchema.optional(),
  timestamp: timestampSchema,
  payload: emptyPayloadSchema,
}).strict();

const statusMessageSchema = z.object({
  type: z.literal("status"),
  requestId: requestIdSchema.optional(),
  timestamp: timestampSchema,
  payload: deviceStatusSchema,
}).strict();

const clientMessageSchema = z.discriminatedUnion("type", [
  helloMessageSchema,
  heartbeatMessageSchema,
  pingMessageSchema,
  pongMessageSchema,
  statusMessageSchema,
]);

export type DirectDeviceStatus = z.infer<typeof deviceStatusSchema>;
export type DirectGlassesHello = z.infer<typeof helloPayloadSchema>;
type DirectClientMessage = z.infer<typeof clientMessageSchema>;
type DirectResponseType = "pong" | "status";

export type DirectGlassesGatewayConfig = {
  /** Development-only shared secret fallback. Prefer an injected Cloudflare Access authenticator. */
  deviceToken?: string;
  upgradeAuthenticator?: DirectGlassesUpgradeAuthenticator;
  authRenewalSkewMs?: number;
  path?: string;
  maxPayloadBytes?: number;
  helloTimeoutMs?: number;
  heartbeatTimeoutMs?: number;
  requestTimeoutMs?: number;
  sweepIntervalMs?: number;
  maxPendingRequests?: number;
};

export type DirectGlassesAuthIdentity = {
  kind: "cloudflare_access" | "development_token";
  principalId: string;
  allowedDeviceId?: string;
  expiresAtMs?: number;
};

export type DirectGlassesUpgradeAuthenticator = (
  request: IncomingMessage,
) => Promise<DirectGlassesAuthIdentity | undefined>;

/** Development-only authenticator retained for the first LAN hardware ping. */
function createDevelopmentTokenAuthenticator(
  expectedToken: string,
): DirectGlassesUpgradeAuthenticator | undefined {
  const expected = Buffer.from(expectedToken);
  if (expected.length === 0) return undefined;
  return async (request) => {
    const header = request.headers["x-cally-device-token"];
    if (typeof header !== "string") return undefined;
    const actual = Buffer.from(header);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined;
    return {
      kind: "development_token",
      principalId: "development-shared-token",
    };
  };
}

type DirectGlassesLogger = {
  debug?: (details: Record<string, unknown>, message: string) => void;
  info?: (details: Record<string, unknown>, message: string) => void;
  warn?: (details: Record<string, unknown>, message: string) => void;
  error?: (details: Record<string, unknown>, message: string) => void;
};

type PendingRequest = {
  expectedType: DirectResponseType;
  sentAt: number;
  timeout: NodeJS.Timeout;
  resolve: (response: DirectDeviceResponse) => void;
  reject: (error: Error) => void;
};

type ConnectionContext = {
  socket: WebSocket;
  auth: DirectGlassesAuthIdentity;
  authRenewAtMs?: number;
  remoteAddress?: string;
  openedAt: number;
  lastSeenAt: number;
  lastHeartbeatAt?: number;
  hello?: DirectGlassesHello;
  lastStatus?: DirectDeviceStatus;
  helloTimeout?: NodeJS.Timeout;
  pending: Map<string, PendingRequest>;
};

export type DirectDeviceSnapshot = {
  deviceId: string;
  authKind: DirectGlassesAuthIdentity["kind"];
  authPrincipalId: string;
  authExpiresAt?: string;
  processSid?: string;
  deviceModel?: string;
  androidVersion?: string;
  androidSdk?: number;
  appVersion?: string;
  connectedAt: string;
  lastSeenAt: string;
  lastHeartbeatAt?: string;
  remoteAddress?: string;
  status?: DirectDeviceStatus;
};

export type DirectDeviceResponse = {
  deviceId: string;
  requestId: string;
  type: DirectResponseType;
  timestamp: number;
  receivedAt: string;
  roundTripMs: number;
  payload: DirectDeviceStatus | Record<string, never>;
};

export class DirectDeviceNotFoundError extends Error {
  constructor(readonly deviceId: string) {
    super(`Direct glasses device is not connected: ${deviceId}`);
    this.name = "DirectDeviceNotFoundError";
  }
}

export class DirectDeviceRequestTimeoutError extends Error {
  constructor(readonly deviceId: string, readonly requestType: "ping" | "status") {
    super(`Direct glasses ${requestType} request timed out for ${deviceId}`);
    this.name = "DirectDeviceRequestTimeoutError";
  }
}

export class DirectDeviceBusyError extends Error {
  constructor(readonly deviceId: string) {
    super(`Direct glasses device has too many pending requests: ${deviceId}`);
    this.name = "DirectDeviceBusyError";
  }
}

/**
 * Independent control-plane endpoint for a glasses-side Wi-Fi client.
 *
 * This deliberately does not share the Mentra SDK session transport. The first
 * POC only tracks liveness/device status and supports correlated ping/status
 * requests; media and hardware commands remain on the existing SDK path.
 */
export class DirectGlassesGateway {
  private readonly path: string;
  private readonly upgradeAuthenticator?: DirectGlassesUpgradeAuthenticator;
  private readonly authRenewalSkewMs: number;
  private readonly helloTimeoutMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly sweepIntervalMs: number;
  private readonly maxPendingRequests: number;
  private readonly logger?: DirectGlassesLogger;
  private readonly webSocketServer: WebSocketServer;
  private readonly connections = new Set<ConnectionContext>();
  private readonly devices = new Map<string, ConnectionContext>();
  private attachedServer?: HttpServer;
  private sweepTimer?: NodeJS.Timeout;
  private closed = false;

  constructor(config: DirectGlassesGatewayConfig, logger?: DirectGlassesLogger) {
    this.path = config.path || DIRECT_GLASSES_PATH;
    this.upgradeAuthenticator = config.upgradeAuthenticator
      ?? createDevelopmentTokenAuthenticator(config.deviceToken || "");
    this.authRenewalSkewMs = config.authRenewalSkewMs ?? 60_000;
    this.helloTimeoutMs = config.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
    this.heartbeatTimeoutMs = config.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    this.requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.sweepIntervalMs = config.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.maxPendingRequests = config.maxPendingRequests ?? DEFAULT_MAX_PENDING_REQUESTS;
    this.logger = logger;
    this.webSocketServer = new WebSocketServer({
      noServer: true,
      maxPayload: config.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
      perMessageDeflate: false,
    });
    this.webSocketServer.on("error", (error) => {
      this.log("error", { error: this.shortError(error) }, "Direct glasses WebSocket server error");
    });
  }

  get enabled(): boolean {
    return Boolean(this.upgradeAuthenticator);
  }

  attach(server: HttpServer): void {
    if (this.closed) throw new Error("Direct glasses gateway is closed");
    if (this.attachedServer) throw new Error("Direct glasses gateway is already attached");
    this.attachedServer = server;
    server.on("upgrade", this.handleUpgrade);
    this.sweepTimer = setInterval(() => this.sweepStaleConnections(), this.sweepIntervalMs);
    this.sweepTimer.unref();

    if (!this.enabled) {
      this.log("warn", {}, "Direct glasses WSS is disabled because no device authenticator is configured");
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;

    if (this.attachedServer) {
      this.attachedServer.off("upgrade", this.handleUpgrade);
      this.attachedServer = undefined;
    }
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }

    for (const connection of [...this.connections]) {
      this.cleanupConnection(connection, new Error("Direct glasses gateway stopped"));
      connection.socket.terminate();
    }
    this.connections.clear();
    this.devices.clear();

    try {
      this.webSocketServer.close();
    } catch {
      // A no-server WebSocketServer may already be fully closed.
    }
  }

  listDevices(): DirectDeviceSnapshot[] {
    return [...this.devices.values()]
      .map((connection) => this.publicDevice(connection))
      .sort((left, right) => left.deviceId.localeCompare(right.deviceId));
  }

  getDevice(deviceId: string): DirectDeviceSnapshot | undefined {
    const connection = this.devices.get(deviceId);
    return connection ? this.publicDevice(connection) : undefined;
  }

  requestPing(deviceId: string): Promise<DirectDeviceResponse> {
    return this.requestDevice(deviceId, "ping", "pong");
  }

  requestStatus(deviceId: string): Promise<DirectDeviceResponse> {
    return this.requestDevice(deviceId, "status", "status");
  }

  private readonly handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    let pathname: string;
    try {
      pathname = new URL(request.url || "/", "http://localhost").pathname;
    } catch {
      this.rejectUpgrade(socket, 400, "Bad Request");
      return;
    }

    if (pathname !== this.path) {
      // This app currently owns the HTTP server's upgrade surface. Explicitly
      // close unknown paths so abandoned raw sockets cannot accumulate.
      this.rejectUpgrade(socket, 404, "Not Found");
      return;
    }
    if (!this.enabled) {
      this.rejectUpgrade(socket, 503, "Service Unavailable");
      return;
    }
    void this.authenticateAndUpgrade(request, socket, head);
  };

  private async authenticateAndUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    let identity: DirectGlassesAuthIdentity | undefined;
    try {
      identity = await this.upgradeAuthenticator?.(request);
    } catch (error) {
      this.log("error", {
        errorType: error instanceof Error ? error.name : "unknown",
        remoteAddress: request.socket.remoteAddress,
      }, "Direct glasses authentication unavailable");
      this.rejectUpgrade(socket, 503, "Service Unavailable");
      return;
    }

    if (this.closed) {
      this.rejectUpgrade(socket, 503, "Service Unavailable");
      return;
    }
    if (!identity) {
      this.log("warn", { remoteAddress: request.socket.remoteAddress }, "Rejected unauthenticated direct glasses connection");
      this.rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }

    try {
      this.webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        this.acceptConnection(webSocket, request, identity);
      });
    } catch (error) {
      this.log("warn", {
        errorType: error instanceof Error ? error.name : "unknown",
        remoteAddress: request.socket.remoteAddress,
      }, "Direct glasses WebSocket upgrade failed");
      socket.destroy();
    }
  }

  private rejectUpgrade(socket: Duplex, status: number, reason: string): void {
    const body = `${reason}\n`;
    socket.end(
      `HTTP/1.1 ${status} ${reason}\r\n`
      + "Connection: close\r\n"
      + "Content-Type: text/plain; charset=utf-8\r\n"
      + `Content-Length: ${Buffer.byteLength(body)}\r\n`
      + "\r\n"
      + body,
    );
  }

  private acceptConnection(
    socket: WebSocket,
    request: IncomingMessage,
    auth: DirectGlassesAuthIdentity,
  ): void {
    const now = Date.now();
    const authRemainingMs = auth.expiresAtMs === undefined ? undefined : auth.expiresAtMs - now;
    const authRenewAtMs = authRemainingMs === undefined
      ? undefined
      : auth.expiresAtMs! - Math.min(
        this.authRenewalSkewMs,
        Math.max(1_000, Math.floor(authRemainingMs / 5)),
      );
    const connection: ConnectionContext = {
      socket,
      auth,
      authRenewAtMs,
      remoteAddress: request.socket.remoteAddress,
      openedAt: now,
      lastSeenAt: now,
      pending: new Map(),
    };
    this.connections.add(connection);

    connection.helloTimeout = setTimeout(() => {
      if (!connection.hello) socket.close(4002, "hello timeout");
    }, this.helloTimeoutMs);
    connection.helloTimeout.unref();

    socket.on("message", (data, isBinary) => this.handleMessage(connection, data, isBinary));
    socket.on("close", () => this.cleanupConnection(connection, new Error("Direct glasses connection closed")));
    socket.on("error", (error) => {
      this.log("warn", { error: this.shortError(error), deviceId: connection.hello?.deviceId }, "Direct glasses socket error");
    });
  }

  private handleMessage(connection: ConnectionContext, data: RawData, isBinary: boolean): void {
    if (isBinary) {
      connection.socket.close(1003, "binary messages are not supported");
      return;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(data.toString());
    } catch {
      connection.socket.close(1007, "invalid JSON");
      return;
    }

    const parsed = clientMessageSchema.safeParse(raw);
    if (!parsed.success) {
      connection.socket.close(1007, "invalid message");
      return;
    }

    const message = parsed.data;
    if (!connection.hello) {
      if (message.type !== "hello") {
        connection.socket.close(1008, "hello required");
        return;
      }
      this.registerHello(connection, message);
      return;
    }
    if (message.type === "hello") {
      connection.socket.close(1008, "hello already received");
      return;
    }

    connection.lastSeenAt = Date.now();
    switch (message.type) {
      case "heartbeat":
        connection.lastHeartbeatAt = Date.now();
        connection.lastStatus = { ...connection.lastStatus, ...message.payload };
        return;
      case "ping":
        this.send(connection, {
          type: "pong",
          ...(message.requestId ? { requestId: message.requestId } : {}),
          timestamp: Date.now(),
          payload: {},
        });
        return;
      case "pong":
        this.resolvePending(connection, message);
        return;
      case "status":
        connection.lastStatus = { ...connection.lastStatus, ...message.payload };
        this.resolvePending(connection, message);
        return;
    }
  }

  private registerHello(connection: ConnectionContext, message: z.infer<typeof helloMessageSchema>): void {
    if (connection.auth.allowedDeviceId
      && connection.auth.allowedDeviceId !== message.payload.deviceId) {
      this.log("warn", {
        authKind: connection.auth.kind,
        authPrincipalId: connection.auth.principalId,
        claimedDeviceId: message.payload.deviceId,
      }, "Rejected direct glasses identity mismatch");
      connection.socket.close(1008, "authenticated device identity mismatch");
      return;
    }

    const now = Date.now();
    connection.hello = message.payload;
    connection.lastSeenAt = now;
    connection.lastHeartbeatAt = now;
    if (connection.helloTimeout) {
      clearTimeout(connection.helloTimeout);
      connection.helloTimeout = undefined;
    }

    const existing = this.devices.get(message.payload.deviceId);
    if (existing && existing !== connection) {
      this.rejectPending(existing, new Error("Direct glasses connection replaced"));
      existing.socket.close(4001, "replaced by a newer connection");
    }
    this.devices.set(message.payload.deviceId, connection);

    this.send(connection, {
      type: "hello",
      ...(message.requestId ? { requestId: message.requestId } : {}),
      timestamp: now,
      payload: {
        accepted: true,
        protocolVersion: 1,
        heartbeatTimeoutMs: this.heartbeatTimeoutMs,
      },
    });
    this.log("info", {
      authKind: connection.auth.kind,
      authPrincipalId: connection.auth.principalId,
      deviceId: message.payload.deviceId,
      processSid: message.payload.processSid,
      remoteAddress: connection.remoteAddress,
    }, "Direct glasses connected");
  }

  private resolvePending(
    connection: ConnectionContext,
    message: Extract<DirectClientMessage, { type: "pong" | "status" }>,
  ): void {
    if (!message.requestId) return;
    const pending = connection.pending.get(message.requestId);
    if (!pending || pending.expectedType !== message.type || !connection.hello) return;

    clearTimeout(pending.timeout);
    connection.pending.delete(message.requestId);
    const now = Date.now();
    pending.resolve({
      deviceId: connection.hello.deviceId,
      requestId: message.requestId,
      type: message.type,
      timestamp: message.timestamp,
      receivedAt: new Date(now).toISOString(),
      roundTripMs: now - pending.sentAt,
      payload: message.payload,
    });
  }

  private requestDevice(
    deviceId: string,
    requestType: "ping" | "status",
    responseType: DirectResponseType,
  ): Promise<DirectDeviceResponse> {
    const connection = this.devices.get(deviceId);
    if (!connection || connection.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new DirectDeviceNotFoundError(deviceId));
    }
    if (connection.pending.size >= this.maxPendingRequests) {
      return Promise.reject(new DirectDeviceBusyError(deviceId));
    }

    const requestId = `server-${randomUUID()}`;
    const sentAt = Date.now();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        connection.pending.delete(requestId);
        reject(new DirectDeviceRequestTimeoutError(deviceId, requestType));
      }, this.requestTimeoutMs);
      timeout.unref();
      connection.pending.set(requestId, {
        expectedType: responseType,
        sentAt,
        timeout,
        resolve,
        reject,
      });

      this.send(connection, {
        type: requestType,
        requestId,
        timestamp: sentAt,
        payload: {},
      }, (error) => {
        if (!error) return;
        const pending = connection.pending.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timeout);
        connection.pending.delete(requestId);
        pending.reject(error);
      });
    });
  }

  private send(connection: ConnectionContext, message: Record<string, unknown>, callback?: (error?: Error) => void): void {
    if (connection.socket.readyState !== WebSocket.OPEN) {
      callback?.(new Error("Direct glasses socket is not open"));
      return;
    }
    connection.socket.send(JSON.stringify(message), callback);
  }

  private sweepStaleConnections(): void {
    const now = Date.now();
    for (const connection of this.connections) {
      if (connection.authRenewAtMs !== undefined && now >= connection.authRenewAtMs) {
        this.log("info", {
          authKind: connection.auth.kind,
          authPrincipalId: connection.auth.principalId,
          deviceId: connection.hello?.deviceId,
        }, "Renewing direct glasses authentication by reconnecting");
        connection.socket.close(4003, "authentication renewal required");
        continue;
      }
      if (!connection.hello) continue;
      if (!connection.lastHeartbeatAt) continue;
      if (now - connection.lastHeartbeatAt > this.heartbeatTimeoutMs) {
        this.log("warn", { deviceId: connection.hello?.deviceId }, "Closing stale direct glasses connection");
        connection.socket.close(4000, "heartbeat timeout");
      }
    }
  }

  private cleanupConnection(connection: ConnectionContext, error: Error): void {
    if (connection.helloTimeout) {
      clearTimeout(connection.helloTimeout);
      connection.helloTimeout = undefined;
    }
    this.rejectPending(connection, error);
    this.connections.delete(connection);

    const deviceId = connection.hello?.deviceId;
    if (deviceId && this.devices.get(deviceId) === connection) {
      this.devices.delete(deviceId);
      this.log("info", { deviceId }, "Direct glasses disconnected");
    }
  }

  private rejectPending(connection: ConnectionContext, error: Error): void {
    for (const pending of connection.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    connection.pending.clear();
  }

  private publicDevice(connection: ConnectionContext): DirectDeviceSnapshot {
    const hello = connection.hello;
    if (!hello) throw new Error("Cannot expose a direct device before hello");
    return {
      deviceId: hello.deviceId,
      authKind: connection.auth.kind,
      authPrincipalId: connection.auth.principalId,
      authExpiresAt: connection.auth.expiresAtMs === undefined
        ? undefined
        : new Date(connection.auth.expiresAtMs).toISOString(),
      processSid: hello.processSid,
      deviceModel: hello.deviceModel,
      androidVersion: hello.androidVersion,
      androidSdk: hello.androidSdk,
      appVersion: hello.appVersion,
      connectedAt: new Date(connection.openedAt).toISOString(),
      lastSeenAt: new Date(connection.lastSeenAt).toISOString(),
      lastHeartbeatAt: connection.lastHeartbeatAt
        ? new Date(connection.lastHeartbeatAt).toISOString()
        : undefined,
      remoteAddress: connection.remoteAddress,
      status: connection.lastStatus ? { ...connection.lastStatus } : undefined,
    };
  }

  private shortError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.length > 200 ? `${message.slice(0, 199)}…` : message;
  }

  private log(level: keyof DirectGlassesLogger, details: Record<string, unknown>, message: string): void {
    this.logger?.[level]?.(details, message);
  }
}

export type DirectGlassesHttpAuthorizer = (request: Request) => boolean;

/** Build a header-only, constant-time bearer-token authorizer for direct diagnostics. */
export function createDirectGlassesBearerAuthorizer(
  expectedToken: string,
): DirectGlassesHttpAuthorizer {
  const expected = Buffer.from(expectedToken);
  return (request: Request): boolean => {
    if (expected.length === 0) return false;
    const header = request.headers.authorization;
    if (typeof header !== "string") return false;
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (!match) return false;
    const actual = Buffer.from(match[1]);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
}

/** Registers control-token protected diagnostics and ping/status routes. */
export function registerDirectGlassesHttpRoutes(
  app: Express,
  gateway: DirectGlassesGateway,
  authorized: DirectGlassesHttpAuthorizer,
): void {
  const requireAuthorization = (request: Request, response: Response): boolean => {
    if (authorized(request)) return true;
    response.status(401).json({ error: "unauthorized" });
    return false;
  };

  app.get("/v1/glasses", (request, response) => {
    if (!requireAuthorization(request, response)) return;
    const devices = gateway.listDevices();
    response.json({ enabled: gateway.enabled, count: devices.length, devices });
  });

  app.get("/v1/glasses/:deviceId", (request, response) => {
    if (!requireAuthorization(request, response)) return;
    const deviceId = String(request.params.deviceId);
    const device = gateway.getDevice(deviceId);
    if (!device) {
      response.status(404).json({ error: "device_not_connected", deviceId });
      return;
    }
    response.json({ device });
  });

  app.post("/v1/glasses/:deviceId/ping", (request, response) => {
    if (!requireAuthorization(request, response)) return;
    void respondToDeviceRequest(response, () => gateway.requestPing(String(request.params.deviceId)));
  });

  app.post("/v1/glasses/:deviceId/status", (request, response) => {
    if (!requireAuthorization(request, response)) return;
    void respondToDeviceRequest(response, () => gateway.requestStatus(String(request.params.deviceId)));
  });
}

async function respondToDeviceRequest(
  response: Response,
  request: () => Promise<DirectDeviceResponse>,
): Promise<void> {
  try {
    response.json({ ok: true, response: await request() });
  } catch (error) {
    if (error instanceof DirectDeviceNotFoundError) {
      response.status(404).json({ error: "device_not_connected", deviceId: error.deviceId });
      return;
    }
    if (error instanceof DirectDeviceRequestTimeoutError) {
      response.status(504).json({
        error: "device_timeout",
        deviceId: error.deviceId,
        requestType: error.requestType,
      });
      return;
    }
    if (error instanceof DirectDeviceBusyError) {
      response.status(429).json({ error: "device_busy", deviceId: error.deviceId });
      return;
    }
    response.status(500).json({ error: "direct_glasses_request_failed" });
  }
}

export function directGlassesConfigFromEnv(env: NodeJS.ProcessEnv): DirectGlassesGatewayConfig {
  const heartbeatTimeoutMs = boundedInteger(
    env.CALLY_GLASSES_HEARTBEAT_TIMEOUT_MS,
    DEFAULT_HEARTBEAT_TIMEOUT_MS,
    MIN_HEARTBEAT_TIMEOUT_MS,
    10 * 60_000,
  );
  return {
    deviceToken: (env.CALLY_GLASSES_DEVICE_TOKEN || "").trim(),
    authRenewalSkewMs: boundedInteger(
      env.CALLY_GLASSES_AUTH_RENEWAL_SKEW_MS,
      60_000,
      1_000,
      5 * 60_000,
    ),
    path: DIRECT_GLASSES_PATH,
    maxPayloadBytes: boundedInteger(
      env.CALLY_GLASSES_MAX_PAYLOAD_BYTES,
      DEFAULT_MAX_PAYLOAD_BYTES,
      1_024,
      1024 * 1024,
    ),
    helloTimeoutMs: boundedInteger(
      env.CALLY_GLASSES_HELLO_TIMEOUT_MS,
      DEFAULT_HELLO_TIMEOUT_MS,
      1_000,
      60_000,
    ),
    heartbeatTimeoutMs,
    requestTimeoutMs: boundedInteger(
      env.CALLY_GLASSES_REQUEST_TIMEOUT_MS,
      DEFAULT_REQUEST_TIMEOUT_MS,
      250,
      60_000,
    ),
    maxPendingRequests: boundedInteger(
      env.CALLY_GLASSES_MAX_PENDING_REQUESTS,
      DEFAULT_MAX_PENDING_REQUESTS,
      1,
      128,
    ),
    sweepIntervalMs: Math.min(DEFAULT_SWEEP_INTERVAL_MS, Math.max(250, Math.floor(heartbeatTimeoutMs / 4))),
  };
}

function boundedInteger(raw: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const value = Number.parseInt(raw || "", 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}
