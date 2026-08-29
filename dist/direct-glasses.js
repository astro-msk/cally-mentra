"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.DirectGlassesGateway = exports.DirectDeviceBusyError = exports.DirectDeviceRequestTimeoutError = exports.DirectDeviceNotFoundError = exports.DIRECT_GLASSES_PATH = void 0;
exports.createDirectGlassesBearerAuthorizer = createDirectGlassesBearerAuthorizer;
exports.registerDirectGlassesHttpRoutes = registerDirectGlassesHttpRoutes;
exports.directGlassesConfigFromEnv = directGlassesConfigFromEnv;
const node_crypto_1 = require("node:crypto");
const ws_1 = __importStar(require("ws"));
const zod_1 = require("zod");
exports.DIRECT_GLASSES_PATH = "/v1/glasses/connect";
const DEFAULT_MAX_PAYLOAD_BYTES = 16 * 1024;
const DEFAULT_HELLO_TIMEOUT_MS = 10_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 45_000;
const MIN_HEARTBEAT_TIMEOUT_MS = 45_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_SWEEP_INTERVAL_MS = 1_000;
const DEFAULT_MAX_PENDING_REQUESTS = 16;
const requestIdSchema = zod_1.z.string().min(1).max(128);
const timestampSchema = zod_1.z.number().int().nonnegative();
const emptyPayloadSchema = zod_1.z.object({}).strict().optional().default({});
const deviceStatusSchema = zod_1.z.object({
    battery: zod_1.z.number().min(-1).max(100).nullable().optional(),
    charging: zod_1.z.boolean().nullable().optional(),
    wifiConnected: zod_1.z.boolean().nullable().optional(),
    wifiSsid: zod_1.z.string().max(128).nullable().optional(),
    wifiRssi: zod_1.z.number().int().min(-127).max(0).nullable().optional(),
    localIp: zod_1.z.string().max(64).nullable().optional(),
}).strict();
const helloPayloadSchema = zod_1.z.object({
    protocolVersion: zod_1.z.literal(1),
    deviceId: zod_1.z.string().trim().min(1).max(128),
    processSid: zod_1.z.string().trim().min(1).max(64).optional(),
    deviceModel: zod_1.z.string().max(128).optional(),
    androidVersion: zod_1.z.string().max(64).optional(),
    androidSdk: zod_1.z.number().int().nonnegative().optional(),
    appVersion: zod_1.z.string().max(128).optional(),
}).strict();
const helloMessageSchema = zod_1.z.object({
    type: zod_1.z.literal("hello"),
    requestId: requestIdSchema.optional(),
    timestamp: timestampSchema,
    payload: helloPayloadSchema,
}).strict();
const heartbeatMessageSchema = zod_1.z.object({
    type: zod_1.z.literal("heartbeat"),
    requestId: requestIdSchema.optional(),
    timestamp: timestampSchema,
    payload: deviceStatusSchema,
}).strict();
const pingMessageSchema = zod_1.z.object({
    type: zod_1.z.literal("ping"),
    requestId: requestIdSchema.optional(),
    timestamp: timestampSchema,
    payload: emptyPayloadSchema,
}).strict();
const pongMessageSchema = zod_1.z.object({
    type: zod_1.z.literal("pong"),
    requestId: requestIdSchema.optional(),
    timestamp: timestampSchema,
    payload: emptyPayloadSchema,
}).strict();
const statusMessageSchema = zod_1.z.object({
    type: zod_1.z.literal("status"),
    requestId: requestIdSchema.optional(),
    timestamp: timestampSchema,
    payload: deviceStatusSchema,
}).strict();
const clientMessageSchema = zod_1.z.discriminatedUnion("type", [
    helloMessageSchema,
    heartbeatMessageSchema,
    pingMessageSchema,
    pongMessageSchema,
    statusMessageSchema,
]);
/** Development-only authenticator retained for the first LAN hardware ping. */
function createDevelopmentTokenAuthenticator(expectedToken) {
    const expected = Buffer.from(expectedToken);
    if (expected.length === 0)
        return undefined;
    return async (request) => {
        const header = request.headers["x-cally-device-token"];
        if (typeof header !== "string")
            return undefined;
        const actual = Buffer.from(header);
        if (actual.length !== expected.length || !(0, node_crypto_1.timingSafeEqual)(actual, expected))
            return undefined;
        return {
            kind: "development_token",
            principalId: "development-shared-token",
        };
    };
}
class DirectDeviceNotFoundError extends Error {
    deviceId;
    constructor(deviceId) {
        super(`Direct glasses device is not connected: ${deviceId}`);
        this.deviceId = deviceId;
        this.name = "DirectDeviceNotFoundError";
    }
}
exports.DirectDeviceNotFoundError = DirectDeviceNotFoundError;
class DirectDeviceRequestTimeoutError extends Error {
    deviceId;
    requestType;
    constructor(deviceId, requestType) {
        super(`Direct glasses ${requestType} request timed out for ${deviceId}`);
        this.deviceId = deviceId;
        this.requestType = requestType;
        this.name = "DirectDeviceRequestTimeoutError";
    }
}
exports.DirectDeviceRequestTimeoutError = DirectDeviceRequestTimeoutError;
class DirectDeviceBusyError extends Error {
    deviceId;
    constructor(deviceId) {
        super(`Direct glasses device has too many pending requests: ${deviceId}`);
        this.deviceId = deviceId;
        this.name = "DirectDeviceBusyError";
    }
}
exports.DirectDeviceBusyError = DirectDeviceBusyError;
/**
 * Independent control-plane endpoint for a glasses-side Wi-Fi client.
 *
 * This deliberately does not share the Mentra SDK session transport. The first
 * POC only tracks liveness/device status and supports correlated ping/status
 * requests; media and hardware commands remain on the existing SDK path.
 */
class DirectGlassesGateway {
    path;
    upgradeAuthenticator;
    authRenewalSkewMs;
    helloTimeoutMs;
    heartbeatTimeoutMs;
    requestTimeoutMs;
    sweepIntervalMs;
    maxPendingRequests;
    logger;
    webSocketServer;
    connections = new Set();
    devices = new Map();
    attachedServer;
    sweepTimer;
    closed = false;
    constructor(config, logger) {
        this.path = config.path || exports.DIRECT_GLASSES_PATH;
        this.upgradeAuthenticator = config.upgradeAuthenticator
            ?? createDevelopmentTokenAuthenticator(config.deviceToken || "");
        this.authRenewalSkewMs = config.authRenewalSkewMs ?? 60_000;
        this.helloTimeoutMs = config.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
        this.heartbeatTimeoutMs = config.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
        this.requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
        this.sweepIntervalMs = config.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
        this.maxPendingRequests = config.maxPendingRequests ?? DEFAULT_MAX_PENDING_REQUESTS;
        this.logger = logger;
        this.webSocketServer = new ws_1.WebSocketServer({
            noServer: true,
            maxPayload: config.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
            perMessageDeflate: false,
        });
        this.webSocketServer.on("error", (error) => {
            this.log("error", { error: this.shortError(error) }, "Direct glasses WebSocket server error");
        });
    }
    get enabled() {
        return Boolean(this.upgradeAuthenticator);
    }
    attach(server) {
        if (this.closed)
            throw new Error("Direct glasses gateway is closed");
        if (this.attachedServer)
            throw new Error("Direct glasses gateway is already attached");
        this.attachedServer = server;
        server.on("upgrade", this.handleUpgrade);
        this.sweepTimer = setInterval(() => this.sweepStaleConnections(), this.sweepIntervalMs);
        this.sweepTimer.unref();
        if (!this.enabled) {
            this.log("warn", {}, "Direct glasses WSS is disabled because no device authenticator is configured");
        }
    }
    close() {
        if (this.closed)
            return;
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
        }
        catch {
            // A no-server WebSocketServer may already be fully closed.
        }
    }
    listDevices() {
        return [...this.devices.values()]
            .map((connection) => this.publicDevice(connection))
            .sort((left, right) => left.deviceId.localeCompare(right.deviceId));
    }
    getDevice(deviceId) {
        const connection = this.devices.get(deviceId);
        return connection ? this.publicDevice(connection) : undefined;
    }
    requestPing(deviceId) {
        return this.requestDevice(deviceId, "ping", "pong");
    }
    requestStatus(deviceId) {
        return this.requestDevice(deviceId, "status", "status");
    }
    handleUpgrade = (request, socket, head) => {
        let pathname;
        try {
            pathname = new URL(request.url || "/", "http://localhost").pathname;
        }
        catch {
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
    async authenticateAndUpgrade(request, socket, head) {
        let identity;
        try {
            identity = await this.upgradeAuthenticator?.(request);
        }
        catch (error) {
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
        }
        catch (error) {
            this.log("warn", {
                errorType: error instanceof Error ? error.name : "unknown",
                remoteAddress: request.socket.remoteAddress,
            }, "Direct glasses WebSocket upgrade failed");
            socket.destroy();
        }
    }
    rejectUpgrade(socket, status, reason) {
        const body = `${reason}\n`;
        socket.end(`HTTP/1.1 ${status} ${reason}\r\n`
            + "Connection: close\r\n"
            + "Content-Type: text/plain; charset=utf-8\r\n"
            + `Content-Length: ${Buffer.byteLength(body)}\r\n`
            + "\r\n"
            + body);
    }
    acceptConnection(socket, request, auth) {
        const now = Date.now();
        const authRemainingMs = auth.expiresAtMs === undefined ? undefined : auth.expiresAtMs - now;
        const authRenewAtMs = authRemainingMs === undefined
            ? undefined
            : auth.expiresAtMs - Math.min(this.authRenewalSkewMs, Math.max(1_000, Math.floor(authRemainingMs / 5)));
        const connection = {
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
            if (!connection.hello)
                socket.close(4002, "hello timeout");
        }, this.helloTimeoutMs);
        connection.helloTimeout.unref();
        socket.on("message", (data, isBinary) => this.handleMessage(connection, data, isBinary));
        socket.on("close", () => this.cleanupConnection(connection, new Error("Direct glasses connection closed")));
        socket.on("error", (error) => {
            this.log("warn", { error: this.shortError(error), deviceId: connection.hello?.deviceId }, "Direct glasses socket error");
        });
    }
    handleMessage(connection, data, isBinary) {
        if (isBinary) {
            connection.socket.close(1003, "binary messages are not supported");
            return;
        }
        let raw;
        try {
            raw = JSON.parse(data.toString());
        }
        catch {
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
    registerHello(connection, message) {
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
    resolvePending(connection, message) {
        if (!message.requestId)
            return;
        const pending = connection.pending.get(message.requestId);
        if (!pending || pending.expectedType !== message.type || !connection.hello)
            return;
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
    requestDevice(deviceId, requestType, responseType) {
        const connection = this.devices.get(deviceId);
        if (!connection || connection.socket.readyState !== ws_1.default.OPEN) {
            return Promise.reject(new DirectDeviceNotFoundError(deviceId));
        }
        if (connection.pending.size >= this.maxPendingRequests) {
            return Promise.reject(new DirectDeviceBusyError(deviceId));
        }
        const requestId = `server-${(0, node_crypto_1.randomUUID)()}`;
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
                if (!error)
                    return;
                const pending = connection.pending.get(requestId);
                if (!pending)
                    return;
                clearTimeout(pending.timeout);
                connection.pending.delete(requestId);
                pending.reject(error);
            });
        });
    }
    send(connection, message, callback) {
        if (connection.socket.readyState !== ws_1.default.OPEN) {
            callback?.(new Error("Direct glasses socket is not open"));
            return;
        }
        connection.socket.send(JSON.stringify(message), callback);
    }
    sweepStaleConnections() {
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
            if (!connection.hello)
                continue;
            if (!connection.lastHeartbeatAt)
                continue;
            if (now - connection.lastHeartbeatAt > this.heartbeatTimeoutMs) {
                this.log("warn", { deviceId: connection.hello?.deviceId }, "Closing stale direct glasses connection");
                connection.socket.close(4000, "heartbeat timeout");
            }
        }
    }
    cleanupConnection(connection, error) {
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
    rejectPending(connection, error) {
        for (const pending of connection.pending.values()) {
            clearTimeout(pending.timeout);
            pending.reject(error);
        }
        connection.pending.clear();
    }
    publicDevice(connection) {
        const hello = connection.hello;
        if (!hello)
            throw new Error("Cannot expose a direct device before hello");
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
    shortError(error) {
        const message = error instanceof Error ? error.message : String(error);
        return message.length > 200 ? `${message.slice(0, 199)}…` : message;
    }
    log(level, details, message) {
        this.logger?.[level]?.(details, message);
    }
}
exports.DirectGlassesGateway = DirectGlassesGateway;
/** Build a header-only, constant-time bearer-token authorizer for direct diagnostics. */
function createDirectGlassesBearerAuthorizer(expectedToken) {
    const expected = Buffer.from(expectedToken);
    return (request) => {
        if (expected.length === 0)
            return false;
        const header = request.headers.authorization;
        if (typeof header !== "string")
            return false;
        const match = /^Bearer\s+(\S+)$/i.exec(header);
        if (!match)
            return false;
        const actual = Buffer.from(match[1]);
        return actual.length === expected.length && (0, node_crypto_1.timingSafeEqual)(actual, expected);
    };
}
/** Registers control-token protected diagnostics and ping/status routes. */
function registerDirectGlassesHttpRoutes(app, gateway, authorized) {
    const requireAuthorization = (request, response) => {
        if (authorized(request))
            return true;
        response.status(401).json({ error: "unauthorized" });
        return false;
    };
    app.get("/v1/glasses", (request, response) => {
        if (!requireAuthorization(request, response))
            return;
        const devices = gateway.listDevices();
        response.json({ enabled: gateway.enabled, count: devices.length, devices });
    });
    app.get("/v1/glasses/:deviceId", (request, response) => {
        if (!requireAuthorization(request, response))
            return;
        const deviceId = String(request.params.deviceId);
        const device = gateway.getDevice(deviceId);
        if (!device) {
            response.status(404).json({ error: "device_not_connected", deviceId });
            return;
        }
        response.json({ device });
    });
    app.post("/v1/glasses/:deviceId/ping", (request, response) => {
        if (!requireAuthorization(request, response))
            return;
        void respondToDeviceRequest(response, () => gateway.requestPing(String(request.params.deviceId)));
    });
    app.post("/v1/glasses/:deviceId/status", (request, response) => {
        if (!requireAuthorization(request, response))
            return;
        void respondToDeviceRequest(response, () => gateway.requestStatus(String(request.params.deviceId)));
    });
}
async function respondToDeviceRequest(response, request) {
    try {
        response.json({ ok: true, response: await request() });
    }
    catch (error) {
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
function directGlassesConfigFromEnv(env) {
    const heartbeatTimeoutMs = boundedInteger(env.CALLY_GLASSES_HEARTBEAT_TIMEOUT_MS, DEFAULT_HEARTBEAT_TIMEOUT_MS, MIN_HEARTBEAT_TIMEOUT_MS, 10 * 60_000);
    return {
        deviceToken: (env.CALLY_GLASSES_DEVICE_TOKEN || "").trim(),
        authRenewalSkewMs: boundedInteger(env.CALLY_GLASSES_AUTH_RENEWAL_SKEW_MS, 60_000, 1_000, 5 * 60_000),
        path: exports.DIRECT_GLASSES_PATH,
        maxPayloadBytes: boundedInteger(env.CALLY_GLASSES_MAX_PAYLOAD_BYTES, DEFAULT_MAX_PAYLOAD_BYTES, 1_024, 1024 * 1024),
        helloTimeoutMs: boundedInteger(env.CALLY_GLASSES_HELLO_TIMEOUT_MS, DEFAULT_HELLO_TIMEOUT_MS, 1_000, 60_000),
        heartbeatTimeoutMs,
        requestTimeoutMs: boundedInteger(env.CALLY_GLASSES_REQUEST_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS, 250, 60_000),
        maxPendingRequests: boundedInteger(env.CALLY_GLASSES_MAX_PENDING_REQUESTS, DEFAULT_MAX_PENDING_REQUESTS, 1, 128),
        sweepIntervalMs: Math.min(DEFAULT_SWEEP_INTERVAL_MS, Math.max(250, Math.floor(heartbeatTimeoutMs / 4))),
    };
}
function boundedInteger(raw, fallback, minimum, maximum) {
    const value = Number.parseInt(raw || "", 10);
    if (!Number.isFinite(value))
        return fallback;
    return Math.min(maximum, Math.max(minimum, value));
}
