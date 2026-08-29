const assert = require("node:assert/strict");
const { once } = require("node:events");
const { createServer } = require("node:http");
const test = require("node:test");
const express = require("express");
const WebSocket = require("ws");
const {
  DirectGlassesGateway,
  createDirectGlassesBearerAuthorizer,
  directGlassesConfigFromEnv,
  registerDirectGlassesHttpRoutes,
} = require("../dist/direct-glasses.js");

const DEVICE_TOKEN = "test-device-token";
const CONTROL_TOKEN = "test-control-token";

async function startHarness(overrides = {}) {
  const app = express();
  app.use(express.json());
  const gateway = new DirectGlassesGateway({
    deviceToken: DEVICE_TOKEN,
    helloTimeoutMs: 500,
    heartbeatTimeoutMs: 2_000,
    requestTimeoutMs: 500,
    sweepIntervalMs: 25,
    ...overrides,
  });
  registerDirectGlassesHttpRoutes(
    app,
    gateway,
    createDirectGlassesBearerAuthorizer(CONTROL_TOKEN),
  );
  const server = createServer(app);
  gateway.attach(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected an ephemeral TCP address");

  return {
    gateway,
    server,
    httpUrl: `http://127.0.0.1:${address.port}`,
    wsUrl: `ws://127.0.0.1:${address.port}/v1/glasses/connect`,
    async close() {
      gateway.close();
      if (!server.listening) return;
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function connect(url, token = DEVICE_TOKEN) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      headers: token ? { "x-cally-device-token": token } : {},
    });
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function rejectedUpgradeStatus(url, token) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      headers: token ? { "x-cally-device-token": token } : {},
    });
    socket.once("unexpected-response", (_request, response) => {
      const status = response.statusCode;
      response.resume();
      resolve(status);
    });
    socket.once("open", () => reject(new Error("Expected WebSocket upgrade rejection")));
    socket.once("error", () => {
      // `unexpected-response` is the assertion signal; suppress the follow-up
      // transport error emitted by some ws/Node combinations.
    });
  });
}

function nextJson(socket) {
  return new Promise((resolve, reject) => {
    const onMessage = (data, isBinary) => {
      cleanup();
      if (isBinary) {
        reject(new Error("Expected a JSON text message"));
        return;
      }
      try {
        resolve(JSON.parse(data.toString()));
      } catch (error) {
        reject(error);
      }
    };
    const onClose = (code) => {
      cleanup();
      reject(new Error(`Socket closed before message (${code})`));
    };
    const cleanup = () => {
      socket.off("message", onMessage);
      socket.off("close", onClose);
    };
    socket.once("message", onMessage);
    socket.once("close", onClose);
  });
}

async function waitUntil(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function sendHello(socket, deviceId, processSid = "process-a") {
  const acknowledgement = nextJson(socket);
  socket.send(JSON.stringify({
    type: "hello",
    requestId: `hello-${processSid}`,
    timestamp: Date.now(),
    payload: {
      protocolVersion: 1,
      deviceId,
      processSid,
      deviceModel: "Mentra Live",
      androidVersion: "11",
      androidSdk: 30,
      appVersion: "1.0-test",
    },
  }));
  const message = await acknowledgement;
  assert.equal(message.type, "hello");
  assert.equal(message.requestId, `hello-${processSid}`);
  assert.equal(message.payload.accepted, true);
  return message;
}

test("rejects unauthenticated upgrades and protects diagnostics with the control token", async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());

  assert.equal(await rejectedUpgradeStatus(harness.wsUrl), 401);
  assert.equal(await rejectedUpgradeStatus(harness.wsUrl, "wrong-token"), 401);

  const unauthorized = await fetch(`${harness.httpUrl}/v1/glasses`);
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(await unauthorized.json(), { error: "unauthorized" });

  const queryToken = await fetch(
    `${harness.httpUrl}/v1/glasses?token=${encodeURIComponent(CONTROL_TOKEN)}`,
  );
  assert.equal(queryToken.status, 401);

  const authorized = await fetch(`${harness.httpUrl}/v1/glasses`, {
    headers: { authorization: `Bearer ${CONTROL_TOKEN}` },
  });
  assert.equal(authorized.status, 200);
  assert.deepEqual(await authorized.json(), { enabled: true, count: 0, devices: [] });
});

test("rejects unrelated WebSocket upgrade paths instead of leaving raw sockets open", async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());

  const otherUrl = harness.wsUrl.replace("/v1/glasses/connect", "/another-websocket");
  assert.equal(await rejectedUpgradeStatus(otherUrl, DEVICE_TOKEN), 404);
});

test("production heartbeat timeout cannot be shorter than the ASG heartbeat contract", () => {
  const config = directGlassesConfigFromEnv({
    CALLY_GLASSES_DEVICE_TOKEN: DEVICE_TOKEN,
    CALLY_GLASSES_HEARTBEAT_TIMEOUT_MS: "5000",
  });

  assert.equal(config.heartbeatTimeoutMs, 45_000);
});

test("requires hello before any operational message", async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());
  const socket = await connect(harness.wsUrl);
  const closed = once(socket, "close");

  socket.send(JSON.stringify({
    type: "heartbeat",
    timestamp: Date.now(),
    payload: { battery: 80 },
  }));

  const [code, reason] = await closed;
  assert.equal(code, 1008);
  assert.match(reason.toString(), /hello required/);
  assert.equal(harness.gateway.listDevices().length, 0);
});

test("registers hello and replaces an older connection for the same device", async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());
  const first = await connect(harness.wsUrl);
  await sendHello(first, "mentra-live-001", "process-old");
  const firstClosed = once(first, "close");

  const second = await connect(harness.wsUrl);
  await sendHello(second, "mentra-live-001", "process-new");

  const [code] = await firstClosed;
  assert.equal(code, 4001);
  const devices = harness.gateway.listDevices();
  assert.equal(devices.length, 1);
  assert.equal(devices[0].deviceId, "mentra-live-001");
  assert.equal(devices[0].processSid, "process-new");
});

test("binds a Cloudflare Access principal to exactly one claimed device id", async (t) => {
  const expiresAtMs = Date.now() + 60_000;
  const harness = await startHarness({
    deviceToken: "",
    upgradeAuthenticator: async () => ({
      kind: "cloudflare_access",
      principalId: "device-client-id.access",
      allowedDeviceId: "mentra-live-bound",
      expiresAtMs,
    }),
  });
  t.after(() => harness.close());

  const accepted = await connect(harness.wsUrl, "");
  await sendHello(accepted, "mentra-live-bound");
  const snapshot = harness.gateway.getDevice("mentra-live-bound");
  assert.equal(snapshot.authKind, "cloudflare_access");
  assert.equal(snapshot.authPrincipalId, "device-client-id.access");
  assert.equal(snapshot.authExpiresAt, new Date(expiresAtMs).toISOString());

  const impersonator = await connect(harness.wsUrl, "");
  const closed = once(impersonator, "close");
  impersonator.send(JSON.stringify({
    type: "hello",
    timestamp: Date.now(),
    payload: {
      protocolVersion: 1,
      deviceId: "mentra-live-someone-else",
    },
  }));
  const [code, reason] = await closed;
  assert.equal(code, 1008);
  assert.match(reason.toString(), /identity mismatch/);
  assert.equal(harness.gateway.getDevice("mentra-live-someone-else"), undefined);
});

test("reconnects before the Cloudflare Access assertion expires", async (t) => {
  const harness = await startHarness({
    deviceToken: "",
    authRenewalSkewMs: 150,
    sweepIntervalMs: 10,
    upgradeAuthenticator: async () => ({
      kind: "cloudflare_access",
      principalId: "expiring-client-id.access",
      allowedDeviceId: "mentra-live-renew",
      expiresAtMs: Date.now() + 450,
    }),
  });
  t.after(() => harness.close());

  const socket = await connect(harness.wsUrl, "");
  await sendHello(socket, "mentra-live-renew");
  const closed = once(socket, "close");
  const [code, reason] = await closed;

  assert.equal(code, 4003);
  assert.match(reason.toString(), /authentication renewal required/);
  await waitUntil(() => harness.gateway.getDevice("mentra-live-renew") === undefined);
});

test("correlates ping, pong, and status and updates heartbeat telemetry", async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());
  const socket = await connect(harness.wsUrl);
  await sendHello(socket, "mentra-live-002");

  const incomingPing = nextJson(socket);
  const pingResultPromise = harness.gateway.requestPing("mentra-live-002");
  const ping = await incomingPing;
  assert.equal(ping.type, "ping");
  socket.send(JSON.stringify({
    type: "pong",
    requestId: ping.requestId,
    timestamp: Date.now(),
    payload: {},
  }));
  const pingResult = await pingResultPromise;
  assert.equal(pingResult.type, "pong");
  assert.equal(pingResult.requestId, ping.requestId);

  const clientPong = nextJson(socket);
  socket.send(JSON.stringify({
    type: "ping",
    requestId: "client-ping-1",
    timestamp: Date.now(),
    payload: {},
  }));
  assert.equal((await clientPong).requestId, "client-ping-1");

  socket.send(JSON.stringify({
    type: "heartbeat",
    timestamp: Date.now(),
    payload: {
      battery: 82,
      charging: false,
      wifiConnected: true,
      wifiSsid: "Home",
      wifiRssi: -53,
      localIp: "192.168.1.20",
    },
  }));

  const incomingStatus = nextJson(socket);
  const httpRequest = fetch(`${harness.httpUrl}/v1/glasses/mentra-live-002/status`, {
    method: "POST",
    headers: { authorization: `Bearer ${CONTROL_TOKEN}` },
  });
  const statusRequest = await incomingStatus;
  assert.equal(statusRequest.type, "status");
  socket.send(JSON.stringify({
    type: "status",
    requestId: statusRequest.requestId,
    timestamp: Date.now(),
    payload: { battery: 81, wifiConnected: true, wifiRssi: -55 },
  }));

  const httpResponse = await httpRequest;
  assert.equal(httpResponse.status, 200);
  const body = await httpResponse.json();
  assert.equal(body.ok, true);
  assert.equal(body.response.type, "status");
  assert.equal(body.response.requestId, statusRequest.requestId);
  assert.equal(body.response.payload.battery, 81);

  const snapshot = harness.gateway.getDevice("mentra-live-002");
  assert.equal(snapshot.status.battery, 81);
  assert.equal(snapshot.status.wifiSsid, "Home");
  assert.ok(snapshot.lastHeartbeatAt);
});

test("closes malformed and oversized messages", async (t) => {
  const harness = await startHarness({ maxPayloadBytes: 512 });
  t.after(() => harness.close());

  const malformed = await connect(harness.wsUrl);
  const malformedClosed = once(malformed, "close");
  malformed.send("not-json");
  assert.equal((await malformedClosed)[0], 1007);

  const oversized = await connect(harness.wsUrl);
  const oversizedClosed = once(oversized, "close");
  oversized.send("x".repeat(513));
  assert.equal((await oversizedClosed)[0], 1009);
});

test("expires devices that stop sending heartbeats", async (t) => {
  const harness = await startHarness({
    heartbeatTimeoutMs: 80,
    sweepIntervalMs: 10,
  });
  t.after(() => harness.close());
  const socket = await connect(harness.wsUrl);
  await sendHello(socket, "mentra-live-stale");
  const closed = once(socket, "close");

  const [code, reason] = await closed;
  assert.equal(code, 4000);
  assert.match(reason.toString(), /heartbeat timeout/);
  await waitUntil(() => harness.gateway.listDevices().length === 0);
  assert.equal(harness.gateway.listDevices().length, 0);
});

test("shutdown terminates sockets and rejects pending requests", async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());
  const socket = await connect(harness.wsUrl);
  await sendHello(socket, "mentra-live-shutdown");

  const incomingPing = nextJson(socket);
  const pending = harness.gateway.requestPing("mentra-live-shutdown");
  await incomingPing;
  harness.gateway.close();

  await assert.rejects(pending, /gateway stopped/);
  assert.equal(harness.gateway.listDevices().length, 0);
});
