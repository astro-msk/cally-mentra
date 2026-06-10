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
require("dotenv/config");
const sdk_1 = require("@mentra/sdk");
const zod_1 = require("zod");
const fs = __importStar(require("node:fs/promises"));
const node_fs_1 = require("node:fs");
const path = __importStar(require("node:path"));
const losefit_1 = require("./losefit");
const agent_cli_1 = require("./agent-cli");
const openai_bridge_1 = require("./openai-bridge");
const sound_1 = require("./sound");
const wake_1 = require("./wake");
const os = __importStar(require("node:os"));
const PORT = parseInt(process.env.PORT || "3017", 10);
const PACKAGE_NAME = process.env.PACKAGE_NAME || "com.mukil.cally";
const MENTRAOS_API_KEY = process.env.MENTRAOS_API_KEY;
const CONTROL_TOKEN = process.env.CALLY_MENTRA_CONTROL_TOKEN || "";
const CALLY_AGENT_WEBHOOK_URL = process.env.CALLY_AGENT_WEBHOOK_URL || "";
const CALLY_AGENT_BEARER_TOKEN = process.env.CALLY_AGENT_BEARER_TOKEN || "";
// Local OpenClaw CLI bridge: used when no webhook URL is configured so the
// local setup still gets full Cally reasoning without standing up an HTTP gateway.
// Direct OpenAI bridge — the low-latency primary path for the glasses. Calls the
// Chat Completions API straight from this warm process with a compressed digest
// of Cally's brain as the system prompt, bypassing the slow full-agent turn.
const CALLY_OPENAI_API_KEY = process.env.CALLY_OPENAI_API_KEY || "";
const CALLY_OPENAI_ENABLED = (process.env.CALLY_OPENAI_ENABLED || "true").toLowerCase() !== "false"
    && Boolean(CALLY_OPENAI_API_KEY);
const CALLY_OPENAI_MODEL = process.env.CALLY_OPENAI_MODEL || "gpt-5.4-mini";
const CALLY_OPENAI_BASE_URL = (process.env.CALLY_OPENAI_BASE_URL || "https://api.openai.com").replace(/\/+$/, "");
const CALLY_OPENAI_MAX_TOKENS = Math.max(64, parseInt(process.env.CALLY_OPENAI_MAX_TOKENS || "400", 10) || 400);
const CALLY_OPENAI_TIMEOUT_MS = Math.max(2000, parseInt(process.env.CALLY_OPENAI_TIMEOUT_MS || "12000", 10) || 12000);
const CALLY_OPENAI_DIGEST_PATH = process.env.CALLY_OPENAI_DIGEST_PATH
    || path.join(os.homedir(), ".openclaw", "workspace-glasses", "AGENTS.md");
const CALLY_AGENT_CLI_ENABLED = (process.env.CALLY_AGENT_CLI_ENABLED || "true").toLowerCase() !== "false";
const CALLY_AGENT_CLI_PATH = process.env.CALLY_AGENT_CLI_PATH || "openclaw";
const CALLY_AGENT_CLI_TIMEOUT_SECONDS = Math.max(5, parseInt(process.env.CALLY_AGENT_CLI_TIMEOUT_SECONDS || "45", 10) || 45);
const CALLY_AGENT_SESSION_PREFIX = process.env.CALLY_AGENT_SESSION_PREFIX || "mentra";
// Thinking level for the local agent turn. "minimal" keeps voice replies snappy;
// raise it (low/medium/high) if you want deeper reasoning at the cost of latency.
const CALLY_AGENT_CLI_THINKING = process.env.CALLY_AGENT_CLI_THINKING || "minimal";
// Optional model override for the agent turn (provider/model or model id).
const CALLY_AGENT_CLI_MODEL = process.env.CALLY_AGENT_CLI_MODEL || "";
const CAPTURE_DIR = process.env.CALLY_MENTRA_CAPTURE_DIR
    || path.resolve(process.cwd(), "../../data/mentra-captures");
// Public HTTPS base (e.g. https://mentra.example.com) the glasses can reach to
// fetch the wake-word acknowledgement chime. Without it, the chime is skipped.
const CALLY_PUBLIC_URL = (process.env.CALLY_PUBLIC_URL || "").replace(/\/+$/, "");
const CALLY_ACK_SOUND = (process.env.CALLY_ACK_SOUND || "true").toLowerCase() !== "false";
// Override the chime with any glasses-reachable audio URL; defaults to the MP3
// this app serves at /assets/cally-ack.mp3.
const CALLY_ACK_SOUND_URL = process.env.CALLY_ACK_SOUND_URL
    || (CALLY_PUBLIC_URL ? `${CALLY_PUBLIC_URL}/assets/cally-ack.mp3` : "");
// Speech-to-text language. Indian English ("en-IN") recognises the wake word and
// accented speech far better than the default US English for that accent.
const CALLY_TRANSCRIBE_LANGUAGE = process.env.CALLY_TRANSCRIBE_LANGUAGE || "en-US";
// Wake-word tuning: extra accepted spellings + fuzzy phonetic matching.
const CALLY_WAKE_WORDS = process.env.CALLY_WAKE_WORDS || "";
const CALLY_WAKE_FUZZY = (process.env.CALLY_WAKE_FUZZY || "true").toLowerCase() !== "false";
const SPEAK_REPLIES = (process.env.CALLY_SPEAK_REPLIES || "true").toLowerCase() !== "false";
const SPEAK_ON_STARTUP = (process.env.CALLY_MENTRA_SPEAK_ON_STARTUP || "false").toLowerCase() === "true";
const LED_FEEDBACK = (process.env.CALLY_MENTRA_LED_FEEDBACK || "false").toLowerCase() === "true";
const ADVANCED_STREAMS = (process.env.CALLY_MENTRA_ADVANCED_STREAMS || "false").toLowerCase() === "true";
const USE_DISPLAY = (process.env.CALLY_MENTRA_USE_DISPLAY || "false").toLowerCase() === "true";
if (!MENTRAOS_API_KEY) {
    console.error("MENTRAOS_API_KEY is required. Copy .env.example to .env and configure it.");
    process.exit(1);
}
// --- Quiet a known-benign, self-recovered log line from @mentra/sdk ---------
// The SDK registers a global auth middleware that calls verifyFrontendToken()
// on every request. When a MentraOS webview request arrives with a frontend
// token that is not in the SDK's `userId:hash` form, that function throws
// internally, console.error()s "Frontend token verification failed: ...", and
// then catches it and falls back to our own CONTROL_TOKEN auth. The token is
// supplied by MentraOS infrastructure, so the app cannot change its format and
// the failure is harmless. Instead of emitting a full stack trace per request,
// we collapse these into a periodic counter while passing every other error
// straight through.
const originalConsoleError = console.error.bind(console);
let suppressedFrontendTokenWarnings = 0;
console.error = (...args) => {
    const first = args[0];
    if (typeof first === "string" && first.startsWith("Frontend token verification failed:")) {
        suppressedFrontendTokenWarnings += 1;
        return;
    }
    originalConsoleError(...args);
};
const frontendTokenWarningTimer = setInterval(() => {
    if (suppressedFrontendTokenWarnings > 0) {
        originalConsoleError(`[cally-mentra] Suppressed ${suppressedFrontendTokenWarnings} benign "invalid frontend token format" warning(s) from @mentra/sdk in the last minute.`);
        suppressedFrontendTokenWarnings = 0;
    }
}, 60_000);
frontendTokenWarningTimer.unref();
// --- Process-level safety net ----------------------------------------------
// A long-running glasses bridge should never die silently on a stray rejected
// promise or background throw. Log with enough context to diagnose, and keep
// serving the active sessions instead of crashing the systemd unit.
process.on("unhandledRejection", (reason) => {
    originalConsoleError("[cally-mentra] Unhandled promise rejection:", reason);
});
process.on("uncaughtException", (error) => {
    originalConsoleError("[cally-mentra] Uncaught exception:", error);
});
const saySchema = zod_1.z.object({
    text: zod_1.z.string().min(1),
    speak: zod_1.z.boolean().optional(),
});
const commandSchema = zod_1.z.object({
    text: zod_1.z.string().min(1),
});
const captureSchema = zod_1.z.object({
    prompt: zod_1.z.string().default("What am I looking at?"),
    size: zod_1.z.enum(["small", "medium", "large", "full"]).default("medium"),
});
const modeSchema = zod_1.z.object({
    mode: zod_1.z.enum(["assist", "captions", "quiet"]),
});
/** Thrown when a control route targets a session id that is not connected. */
class SessionNotFoundError extends Error {
    constructor(sessionId) {
        super(`No active session: ${sessionId}`);
        this.name = "SessionNotFoundError";
    }
}
let ackMp3Cache;
/** Loads the bundled MP3 chime once. Returns null if the asset is missing. */
function ackChimeMp3() {
    if (ackMp3Cache !== undefined)
        return ackMp3Cache;
    const candidates = [
        path.resolve(process.cwd(), "assets/cally-ack.mp3"),
        path.resolve(__dirname, "../assets/cally-ack.mp3"),
    ];
    for (const candidate of candidates) {
        try {
            ackMp3Cache = (0, node_fs_1.readFileSync)(candidate);
            return ackMp3Cache;
        }
        catch {
            // try next candidate
        }
    }
    ackMp3Cache = null;
    return ackMp3Cache;
}
function renderWebviewHtml() {
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Cally</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #f5f7fa;
        color: #171a1f;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        padding: 20px;
      }
      main {
        width: min(100%, 720px);
        margin: 0 auto;
      }
      h1 {
        margin: 0;
        font-size: 30px;
        line-height: 1.1;
        letter-spacing: 0;
      }
      p {
        margin: 8px 0 0;
        color: #596171;
        font-size: 14px;
        line-height: 1.45;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
        gap: 12px;
        margin-top: 18px;
      }
      .panel {
        border: 1px solid #dce2eb;
        border-radius: 8px;
        background: #ffffff;
        overflow: hidden;
      }
      .panel h2 {
        margin: 0;
        padding: 12px 14px;
        font-size: 13px;
        letter-spacing: 0;
        text-transform: uppercase;
        color: #596171;
        border-bottom: 1px solid #edf1f5;
      }
      .row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        min-height: 42px;
        padding: 10px 14px;
        border-top: 1px solid #edf1f5;
        font-size: 14px;
      }
      .row:first-of-type { border-top: 0; }
      .label { color: #596171; }
      .value {
        max-width: 62%;
        overflow-wrap: anywhere;
        text-align: right;
        font-weight: 650;
      }
      .status {
        display: inline-flex;
        align-items: center;
        gap: 8px;
      }
      .dot {
        width: 9px;
        height: 9px;
        border-radius: 999px;
        background: #aeb7c4;
      }
      .dot.ok { background: #16a34a; }
      .dot.warn { background: #eab308; }
      .actions {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
        gap: 8px;
        padding: 12px;
      }
      button, input, select {
        width: 100%;
        min-height: 38px;
        border: 1px solid #cfd7e3;
        border-radius: 8px;
        background: #ffffff;
        color: inherit;
        font: inherit;
      }
      button {
        cursor: pointer;
        font-weight: 650;
      }
      button.primary {
        border-color: #0f766e;
        background: #0f766e;
        color: #ffffff;
      }
      input, select {
        padding: 0 10px;
      }
      .command {
        display: grid;
        grid-template-columns: 1fr 110px;
        gap: 8px;
        padding: 0 12px 12px;
      }
      @media (prefers-color-scheme: dark) {
        :root { background: #101318; color: #f4f7fb; }
        p, .label, .panel h2 { color: #aab3c2; }
        .panel, button, input, select { border-color: #2a313d; background: #171c24; }
        .row, .panel h2 { border-color: #252c36; }
        button.primary { background: #14b8a6; border-color: #14b8a6; color: #06110f; }
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Cally</h1>
      <p>Glasses copilot for voice, vision, status, notes, and quick controls.</p>
      <section class="grid">
        <div class="panel">
          <h2>Status</h2>
          <div class="row"><span class="label">Server</span><span class="value status"><span id="status-dot" class="dot"></span><span id="status-text">Checking</span></span></div>
          <div class="row"><span class="label">Sessions</span><span id="sessions" class="value">-</span></div>
          <div class="row"><span class="label">Package</span><span class="value">${PACKAGE_NAME}</span></div>
        </div>
        <div class="panel">
          <h2>Glasses</h2>
          <div class="row"><span class="label">WiFi</span><span id="wifi" class="value">-</span></div>
          <div class="row"><span class="label">Battery</span><span id="battery" class="value">-</span></div>
          <div class="row"><span class="label">Mode</span><span id="mode" class="value">-</span></div>
        </div>
      </section>
      <section class="panel" style="margin-top:12px">
        <h2>Quick Actions</h2>
        <div class="actions">
          <button data-command="help">Help</button>
          <button data-command="status">Status</button>
          <button data-command="look around" class="primary">Look</button>
          <button data-command="recap">Recap</button>
        </div>
        <div class="command">
          <input id="command-input" placeholder="Ask Cally..." />
          <button id="send-command">Send</button>
        </div>
      </section>
    </main>
    <script>
      const params = new URLSearchParams(location.search);
      const token = params.get("token") || "";
      let sessionId = "";

      async function api(path, options = {}) {
        const headers = { ...(options.headers || {}) };
        const url = new URL(path, location.origin);
        if (token) url.searchParams.set("token", token);
        return fetch(url.pathname + url.search, { ...options, headers, cache: "no-store" });
      }

      async function refreshStatus() {
        const dot = document.getElementById("status-dot");
        const status = document.getElementById("status-text");
        const sessions = document.getElementById("sessions");
        try {
          const response = await fetch("/health", { cache: "no-store" });
          if (!response.ok) throw new Error(String(response.status));
          const data = await response.json();
          dot.className = "dot ok";
          status.textContent = "Online";
          sessions.textContent = String(data.sessions ?? data.activeSessions ?? 0);
          if (!token) return;
          const detailed = await api("/status");
          if (!detailed.ok) return;
          const detail = await detailed.json();
          const first = detail.sessions?.[0];
          sessionId = first?.sessionId || "";
          document.getElementById("mode").textContent = first?.mode || "-";
          document.getElementById("wifi").textContent = first?.device?.wifiConnected
            ? (first.device.wifiSsid || "Connected")
            : "Unknown";
          document.getElementById("battery").textContent =
            first?.device?.batteryLevel == null ? "-" : first.device.batteryLevel + "%";
        } catch {
          dot.className = "dot warn";
          status.textContent = "Unavailable";
          sessions.textContent = "-";
        }
      }

      async function sendCommand(text) {
        if (!token || !sessionId || !text) return;
        await api("/sessions/" + encodeURIComponent(sessionId) + "/command", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text }),
        });
        await refreshStatus();
      }

      document.querySelectorAll("[data-command]").forEach((button) => {
        button.addEventListener("click", () => sendCommand(button.dataset.command));
      });
      document.getElementById("send-command").addEventListener("click", () => {
        const input = document.getElementById("command-input");
        sendCommand(input.value.trim());
        input.value = "";
      });
      refreshStatus();
      setInterval(refreshStatus, 10000);
    </script>
  </body>
</html>`;
}
class CallyMentraApp extends sdk_1.AppServer {
    sessions = new Map();
    loseFit = new losefit_1.LoseFitStore();
    async onSession(session, sessionId, userId) {
        const record = {
            session,
            sessionId,
            userId,
            connectedAt: new Date().toISOString(),
            mode: "assist",
            transcriptHistory: [],
            notes: [],
            device: this.snapshotDevice(session),
            cleanup: [],
        };
        this.sessions.set(sessionId, record);
        await this.loadNotes(record);
        this.wireSessionEvents(record);
        this.subscribeTranscription(record, sessionId);
        session.events.onDisconnected(() => {
            this.cleanupSession(sessionId);
        });
        session.logger.info({ sessionId, userId }, "Cally Mentra session started");
        this.showReady(record);
    }
    async onStop(sessionId, userId, reason) {
        this.cleanupSession(sessionId);
        this.logger.info({ sessionId, userId, reason }, "Cally Mentra session stopped");
    }
    async onToolCall(toolCall) {
        const userId = String(toolCall.userId || toolCall.user_id || "");
        const text = String(toolCall.args?.text || toolCall.text || "");
        const record = [...this.sessions.values()].find((item) => item.userId === userId) || [...this.sessions.values()][0];
        if (!record || !text)
            return "Cally is not connected to an active glasses session.";
        const reply = await this.handleCommand(record, text, "tool");
        return reply;
    }
    wireControlEndpoints() {
        const app = this.getExpressApp();
        app.get("/", (_req, res) => {
            res.redirect(302, "/webview");
        });
        app.get("/webview", (_req, res) => {
            res
                .setHeader("content-security-policy", "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors *")
                .type("html")
                .send(renderWebviewHtml());
        });
        app.get("/assets/cally-ack.mp3", (_req, res) => {
            const mp3 = ackChimeMp3();
            if (!mp3) {
                res.status(404).json({ error: "chime_unavailable" });
                return;
            }
            res
                .setHeader("cache-control", "public, max-age=86400")
                .type("audio/mpeg")
                .send(mp3);
        });
        app.get("/assets/cally-ack.wav", (_req, res) => {
            res
                .setHeader("cache-control", "public, max-age=86400")
                .type("audio/wav")
                .send((0, sound_1.ackChimeWav)());
        });
        app.get("/health", (_req, res) => {
            res.json({
                ok: true,
                app: "cally-mentra",
                packageName: PACKAGE_NAME,
                sessions: this.sessions.size,
                bridgeConfigured: Boolean(CALLY_AGENT_WEBHOOK_URL),
            });
        });
        app.get("/status", (req, res) => {
            if (!this.authorized(req))
                return res.status(401).json({ error: "unauthorized" });
            res.json({
                ok: true,
                sessions: [...this.sessions.values()].map((item) => this.publicSession(item)),
            });
        });
        app.get("/sessions", (req, res) => {
            if (!this.authorized(req))
                return res.status(401).json({ error: "unauthorized" });
            res.json({
                sessions: [...this.sessions.values()].map((item) => this.publicSession(item)),
            });
        });
        app.post("/sessions/:sessionId/say", (req, res) => {
            void this.routeAsync(res, async () => {
                if (!this.authorized(req))
                    return res.status(401).json({ error: "unauthorized" });
                const record = this.requireSession(String(req.params.sessionId));
                const body = saySchema.parse(req.body);
                this.showText(record, body.text);
                if (body.speak ?? true)
                    await this.safeSpeak(record, body.text);
                return { ok: true };
            });
        });
        app.post("/sessions/:sessionId/command", (req, res) => {
            void this.routeAsync(res, async () => {
                if (!this.authorized(req))
                    return res.status(401).json({ error: "unauthorized" });
                const record = this.requireSession(String(req.params.sessionId));
                const body = commandSchema.parse(req.body);
                const reply = await this.handleCommand(record, body.text, "control");
                return { ok: true, reply };
            });
        });
        app.post("/sessions/:sessionId/mode", (req, res) => {
            void this.routeAsync(res, async () => {
                if (!this.authorized(req))
                    return res.status(401).json({ error: "unauthorized" });
                const record = this.requireSession(String(req.params.sessionId));
                const body = modeSchema.parse(req.body);
                record.mode = body.mode;
                const reply = `Mode set to ${body.mode}.`;
                await this.respond(record, reply);
                return { ok: true, mode: record.mode };
            });
        });
        app.post("/sessions/:sessionId/capture", (req, res) => {
            void this.routeAsync(res, async () => {
                if (!this.authorized(req))
                    return res.status(401).json({ error: "unauthorized" });
                const record = this.requireSession(String(req.params.sessionId));
                const body = captureSchema.parse(req.body);
                const reply = await this.captureAndAsk(record, body.prompt, body.size);
                await this.respond(record, reply);
                return { ok: true, reply };
            });
        });
        // Registered after all routes: JSON 404 for unknown paths, then a final
        // 4-arg error handler so a synchronous throw anywhere in the control
        // surface returns clean JSON and a logged stack instead of Express's
        // default HTML error page.
        app.use((req, res) => {
            res.status(404).json({ error: "not_found", path: req.path });
        });
        app.use((err, req, res, next) => {
            this.logger.error({ error: this.shortError(err), path: req.path }, "Unhandled control-route error");
            if (res.headersSent)
                return next(err);
            res.status(500).json({ error: this.shortError(err) });
        });
    }
    wireSessionEvents(record) {
        const session = record.session;
        const device = session.device.state;
        record.cleanup.push(device.wifiConnected.onChange((value) => {
            record.device.wifiConnected = value;
            record.lastEvent = value ? "Glasses WiFi connected" : "Glasses WiFi disconnected";
        }));
        record.cleanup.push(device.wifiSsid.onChange((value) => {
            record.device.wifiSsid = value;
        }));
        record.cleanup.push(device.wifiLocalIp.onChange((value) => {
            record.device.wifiLocalIp = value;
        }));
        record.cleanup.push(device.hotspotEnabled.onChange((value) => {
            record.device.hotspotEnabled = value;
        }));
        record.cleanup.push(device.batteryLevel.onChange((value) => {
            record.device.batteryLevel = value;
        }));
        record.cleanup.push(device.charging.onChange((value) => {
            record.device.charging = value;
        }));
        record.cleanup.push(device.connected.onChange((value) => {
            record.device.glassesConnected = value;
        }));
        record.cleanup.push(device.modelName.onChange((value) => {
            record.device.modelName = value;
        }));
        if (!ADVANCED_STREAMS)
            return;
        record.cleanup.push(session.events.onButtonPress((data) => void this.handleButton(record, data)));
        record.cleanup.push(session.events.onTouchEvent((data) => void this.handleTouch(record, data)));
        record.cleanup.push(session.events.onGlassesBattery((data) => this.handleGlassesBattery(record, data)));
        record.cleanup.push(session.events.onPhoneBattery((data) => this.handlePhoneBattery(record, data)));
        record.cleanup.push(session.events.onLocation((data) => this.handleLocation(record, data)));
        record.cleanup.push(session.events.onPhoneNotifications((data) => void this.handlePhoneNotification(record, data)));
        record.cleanup.push(session.events.on("glasses_connection_state", (data) => this.handleConnectionState(record, data)));
        const cleanupCapabilities = session.events.onCapabilitiesUpdate((data) => {
            record.device.modelName = data.modelName;
            record.lastEvent = "Capabilities updated";
        });
        record.cleanup.push(() => {
            cleanupCapabilities();
        });
    }
    showReady(record) {
        this.showText(record, "Cally ready. Say: Cally help.", 8000);
        if (SPEAK_ON_STARTUP)
            void this.safeSpeak(record, "Cally is ready.");
    }
    subscribeTranscription(record, sessionId) {
        const handler = (data) => {
            void this.handleTranscription(sessionId, data);
        };
        const lang = CALLY_TRANSCRIBE_LANGUAGE;
        try {
            if (lang && lang !== "en-US") {
                // disableLanguageIdentification=true pins STT to the chosen accent model.
                record.cleanup.push(record.session.events.onTranscriptionForLanguage(lang, handler, true));
                record.session.logger.info({ lang }, "Transcription subscribed for language");
                return;
            }
        }
        catch (error) {
            record.session.logger.warn({ error: this.shortError(error), lang }, "Language transcription unavailable; using en-US");
        }
        record.cleanup.push(record.session.events.onTranscription(handler));
    }
    async handleTranscription(sessionId, data) {
        if (!data.isFinal)
            return;
        const record = this.sessions.get(sessionId);
        if (!record)
            return;
        const text = data.text.trim();
        if (!text)
            return;
        record.lastTranscript = text;
        this.pushLimited(record.transcriptHistory, text, 30);
        const command = this.extractWakeCommand(text);
        if (!command) {
            if (record.mode === "captions") {
                this.showText(record, text, 8000);
            }
            return;
        }
        // Wake word confirmed and the speaker has finished — chirp + show that we
        // heard them, then run the (slower) agent turn. Playing now, rather than on
        // an interim transcript, means the cue isn't masked by the user's own voice.
        this.acknowledgeWake(record);
        this.showText(record, "Thinking…", 3000);
        await this.handleCommand(record, command, "voice");
    }
    /** Audible/visible confirmation that the wake word was heard. */
    acknowledgeWake(record) {
        this.showText(record, "Cally listening…", 2500);
        if (CALLY_ACK_SOUND)
            void this.playAckChime(record);
    }
    async playAckChime(record) {
        if (!CALLY_ACK_SOUND_URL)
            return;
        try {
            if (record.session.capabilities && record.session.capabilities.hasSpeaker === false)
                return;
            // Same path/params as the (working) TTS reply so the device actually plays
            // it: MP3 over the public URL, default track, stops nothing else of note
            // since no other audio is playing the moment the wake word lands.
            await record.session.audio.playAudio({
                audioUrl: CALLY_ACK_SOUND_URL,
                volume: 1,
            });
        }
        catch (error) {
            record.session.logger.warn({ error: this.shortError(error) }, "Wake-word chime failed");
        }
    }
    wakeOptions = {
        extraVariants: (0, wake_1.parseExtraVariants)(CALLY_WAKE_WORDS),
        fuzzy: CALLY_WAKE_FUZZY,
    };
    extractWakeCommand(text) {
        return (0, wake_1.extractWakeCommand)(text, this.wakeOptions);
    }
    async handleCommand(record, rawCommand, origin) {
        const command = rawCommand.trim();
        const normalized = command.toLowerCase();
        if (!command || /^(help|commands|what can you do|menu)$/i.test(command)) {
            const reply = "Try: status, look/read this, remember <note>, recap, captions, quiet, speak.";
            await this.respond(record, reply, "Help");
            return reply;
        }
        if (/^(status|battery|wifi|connection|diagnostics)$/i.test(command)) {
            const reply = this.formatStatus(record);
            await this.respond(record, reply, "Status");
            return reply;
        }
        // Real-time facts answered locally with the device clock — the LLM has no
        // live clock, so this is both faster (no network) and actually correct.
        if (/\b(?:what'?s?|what\s+is|current|today'?s?)\s+(?:the\s+)?(?:time|date|day)\b|\bwhat\s+day\s+is\s+it\b/i.test(command)) {
            const reply = this.formatDateTime();
            await this.respond(record, reply, "Clock");
            return reply;
        }
        if (/^(captions|caption mode|show captions)$/i.test(command)) {
            record.mode = "captions";
            const reply = "Caption mode on. I will show final speech until you say Cally assist.";
            await this.respond(record, reply, "Mode");
            return reply;
        }
        if (/^(assist|assistant mode|normal mode|speak)$/i.test(command)) {
            record.mode = "assist";
            const reply = "Assist mode on.";
            await this.respond(record, reply, "Mode");
            return reply;
        }
        if (/^(quiet|mute|silent)$/i.test(command)) {
            record.mode = "quiet";
            const reply = "Quiet mode on. I will display replies without speaking.";
            await this.respond(record, reply, "Mode");
            return reply;
        }
        if (/^(clear|hide|dismiss)$/i.test(command)) {
            this.clearDisplay(record);
            return "Cleared.";
        }
        const noteMatch = command.match(/^(remember|note|save)\s+(.+)$/i);
        if (noteMatch) {
            const note = noteMatch[2].trim();
            this.pushLimited(record.notes, note, 20);
            await this.saveNotes(record);
            const reply = `Saved: ${note}`;
            await this.respond(record, reply, "Memory");
            return reply;
        }
        if (/^(recap|summary|what did i say|what have i said)$/i.test(command)) {
            const recent = record.transcriptHistory.slice(-5);
            const reply = recent.length ? `Recent: ${recent.join(" / ")}` : "I do not have recent speech yet.";
            await this.respond(record, reply, "Recap");
            return reply;
        }
        const loseFitReply = await this.handleLoseFitCommand(record, command, origin);
        if (loseFitReply)
            return loseFitReply;
        if (/\b(look|see|photo|picture|camera|what am i looking at|read this|read it|scan|ocr)\b/i.test(normalized)) {
            const reply = await this.captureAndAsk(record, command, "medium");
            await this.respond(record, reply, "Vision");
            return reply;
        }
        const reply = await this.askCally(record, {
            kind: origin === "voice" ? "voice" : "control",
            text: command,
            location: record.device.lastLocation,
        });
        await this.respond(record, reply, "Cally");
        return reply;
    }
    async handleLoseFitCommand(record, command, origin) {
        const source = origin === "voice" ? "mentra" : origin;
        if ((0, losefit_1.isLoseFitSummaryCommand)(command)) {
            const reply = (0, losefit_1.formatSummary)(await this.loseFit.summaryForLocalDate());
            await this.respond(record, reply, "LoseFit");
            return reply;
        }
        if (/\b(lose\s*(it|fit))\b.*\b(export|csv)\b/i.test(command)) {
            const csvPath = await this.loseFit.exportCsv();
            const reply = `LoseFit CSV exported: ${csvPath}`;
            await this.respond(record, reply, "LoseFit");
            return reply;
        }
        if ((0, losefit_1.isLoseFitLogCommand)(command)) {
            const entry = await this.loseFit.log(command, source);
            const reply = (0, losefit_1.formatLoggedEntry)(entry);
            await this.respond(record, reply, "LoseFit");
            return reply;
        }
        return null;
    }
    async handleButton(record, data) {
        record.lastEvent = `${data.buttonId} ${data.pressType} press`;
        if (data.pressType === "long") {
            const reply = await this.captureAndAsk(record, "What am I looking at?", "medium");
            await this.respond(record, reply, "Long Press");
            return;
        }
        await this.respond(record, this.formatStatus(record), "Status");
    }
    async handleTouch(record, data) {
        record.lastEvent = `Touch: ${data.gesture_name}`;
        if (/forward|tap|single/i.test(data.gesture_name)) {
            await this.respond(record, "Cally ready. Say help, status, or look.", "Ready");
        }
        else if (/back|long/i.test(data.gesture_name)) {
            this.clearDisplay(record);
        }
    }
    handleGlassesBattery(record, data) {
        record.device.batteryLevel = data.level;
        record.device.charging = data.charging;
        record.lastEvent = `Glasses battery ${data.level}%`;
    }
    handlePhoneBattery(record, data) {
        record.device.phoneBatteryLevel = data.level;
        record.device.phoneCharging = data.charging;
    }
    handleConnectionState(record, data) {
        record.device.modelName = data.modelName;
        record.device.glassesConnected = data.status === "connected";
        record.device.wifiConnected = data.wifi?.connected ?? record.device.wifiConnected;
        record.device.wifiSsid = data.wifi?.ssid ?? record.device.wifiSsid;
        record.lastEvent = `Connection: ${data.status}`;
    }
    handleLocation(record, data) {
        record.device.lastLocation = {
            lat: data.lat,
            lng: data.lng,
            accuracy: data.accuracy,
        };
    }
    async handlePhoneNotification(record, data) {
        if (data.priority !== "high")
            return;
        const content = `${data.app}: ${data.title}`.slice(0, 180);
        this.showCard(record, "Notification", content, 9000);
    }
    async captureAndAsk(record, prompt, size) {
        const session = record.session;
        if (!session.capabilities?.hasCamera) {
            return "I do not see camera support on these glasses.";
        }
        try {
            this.showText(record, "Capturing photo...", 3000);
            const photo = await session.camera.requestPhoto({ size, compress: "medium" });
            const photoPath = await this.savePhoto(record, photo);
            const location = await this.getLocationIfAvailable(session);
            const reply = await this.askCally(record, {
                kind: "photo",
                text: prompt,
                location,
                photo,
                photoPath,
            });
            record.lastReply = reply;
            return reply;
        }
        catch (error) {
            session.logger.error({ error: this.shortError(error) }, "Photo capture failed");
            return "I could not capture a photo from the glasses.";
        }
    }
    /**
     * Persists a captured frame under CAPTURE_DIR so the local agent bridge can
     * reference it by path. Best-effort: a storage failure must not break the
     * reply flow, so we log and return undefined rather than throwing.
     */
    async savePhoto(record, photo) {
        try {
            await fs.mkdir(CAPTURE_DIR, { recursive: true });
            const ext = this.extensionForMime(photo.mimeType);
            const stamp = new Date().toISOString().replace(/[:.]/g, "-");
            const filename = `${stamp}-${this.sanitizeKeySegment(record.userId)}${ext}`;
            const fullPath = path.join(CAPTURE_DIR, filename);
            await fs.writeFile(fullPath, photo.buffer);
            return fullPath;
        }
        catch (error) {
            record.session.logger.warn({ error: this.shortError(error) }, "Failed to save captured photo");
            return undefined;
        }
    }
    extensionForMime(mimeType) {
        if (/png/i.test(mimeType))
            return ".png";
        if (/webp/i.test(mimeType))
            return ".webp";
        if (/jpe?g/i.test(mimeType))
            return ".jpg";
        return ".bin";
    }
    async askCally(record, input) {
        if (CALLY_AGENT_WEBHOOK_URL) {
            try {
                return await this.askViaWebhook(record, input);
            }
            catch (error) {
                record.session.logger.error({ error: this.shortError(error), kind: input.kind }, "Cally webhook bridge failed");
                return "I could not reach the Cally bridge just now.";
            }
        }
        // Primary low-latency path: direct OpenAI with the compressed brain digest.
        if (CALLY_OPENAI_ENABLED && input.kind !== "photo") {
            const fast = await this.askViaOpenAi(record, input);
            if (fast)
                return fast;
        }
        if (CALLY_AGENT_CLI_ENABLED) {
            return this.askViaCli(record, input);
        }
        return this.localReply(record, input);
    }
    openAiConfig = {
        apiKey: CALLY_OPENAI_API_KEY,
        model: CALLY_OPENAI_MODEL,
        digestPath: CALLY_OPENAI_DIGEST_PATH,
        maxTokens: CALLY_OPENAI_MAX_TOKENS,
        timeoutMs: CALLY_OPENAI_TIMEOUT_MS,
        baseUrl: CALLY_OPENAI_BASE_URL,
    };
    async askViaOpenAi(record, input) {
        const result = await (0, openai_bridge_1.callOpenAi)(this.openAiConfig, {
            text: input.text,
            recentTranscripts: record.transcriptHistory.slice(-10),
            notes: record.notes.slice(-10),
        });
        if (!result.ok) {
            record.session.logger.warn({ error: result.error, kind: input.kind }, "OpenAI fast path failed; falling back");
            return null; // fall through to the full agent / local reply
        }
        return this.cleanReply(result.text);
    }
    async askViaWebhook(record, input) {
        const payload = {
            kind: input.kind,
            userId: record.userId,
            sessionId: record.sessionId,
            text: input.text,
            location: input.location,
            device: record.device,
            recentTranscripts: record.transcriptHistory.slice(-10),
            notes: record.notes.slice(-10),
            photo: input.photo
                ? {
                    mimeType: input.photo.mimeType,
                    filename: input.photo.filename,
                    base64: input.photo.buffer.toString("base64"),
                    size: input.photo.size,
                }
                : undefined,
        };
        const response = await fetch(CALLY_AGENT_WEBHOOK_URL, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                ...(CALLY_AGENT_BEARER_TOKEN ? { authorization: `Bearer ${CALLY_AGENT_BEARER_TOKEN}` } : {}),
            },
            body: JSON.stringify(payload),
        });
        if (!response.ok) {
            return `Cally bridge returned ${response.status}.`;
        }
        const json = (await response.json());
        return this.cleanReply(String(json.reply || json.text || json.message || "Done."));
    }
    async askViaCli(record, input) {
        const sessionKey = `${CALLY_AGENT_SESSION_PREFIX}:${this.sanitizeKeySegment(record.userId)}`;
        const message = this.buildCliMessage(record, input);
        const result = await (0, agent_cli_1.callAgentCli)({
            cliPath: CALLY_AGENT_CLI_PATH,
            sessionKey,
            message,
            timeoutSeconds: CALLY_AGENT_CLI_TIMEOUT_SECONDS,
            thinking: CALLY_AGENT_CLI_THINKING,
            model: CALLY_AGENT_CLI_MODEL,
        });
        if (!result.ok) {
            // Never log the constructed message (it can contain the user's speech);
            // only the bridge error, which callAgentCli already truncated for us.
            record.session.logger.error({ error: result.error, kind: input.kind, sessionKey }, "Cally CLI bridge failed");
            return "Cally is having trouble reasoning right now. Try again in a moment.";
        }
        return this.cleanReply(result.text);
    }
    buildCliMessage(record, input) {
        const lines = [input.text.trim()];
        if (input.kind === "photo") {
            lines.push(input.photoPath
                ? `[A photo was just captured from the glasses and saved locally at ${input.photoPath}. Use it to answer the request above; keep the reply short for a heads-up display.]`
                : "[A photo was just captured from the glasses but could not be saved to disk. Answer the request above as best you can.]");
        }
        const recent = record.transcriptHistory.slice(-3).filter((line) => line && line !== input.text);
        if (recent.length) {
            lines.push(`[Recent speech for context: ${recent.join(" | ")}]`);
        }
        return lines.join("\n");
    }
    sanitizeKeySegment(value) {
        const cleaned = (value || "").replace(/[^A-Za-z0-9_.-]/g, "-").replace(/^-+|-+$/g, "");
        return cleaned || "unknown";
    }
    shortError(error) {
        const message = error instanceof Error ? error.message : String(error);
        return message.length > 300 ? `${message.slice(0, 299)}…` : message;
    }
    localReply(record, input) {
        if (input.kind === "photo") {
            return "Photo captured. Full visual reasoning needs the Cally agent bridge, but capture is working.";
        }
        if (/\b(time|date)\b/i.test(input.text)) {
            return new Intl.DateTimeFormat("en-US", {
                timeZone: "America/Los_Angeles",
                weekday: "short",
                hour: "numeric",
                minute: "2-digit",
                month: "short",
                day: "numeric",
            }).format(new Date());
        }
        if (/\b(wifi|battery|status)\b/i.test(input.text)) {
            return this.formatStatus(record);
        }
        return "I can control the glasses locally now. For full Cally reasoning, enable the local CLI bridge (CALLY_AGENT_CLI_ENABLED) or set CALLY_AGENT_WEBHOOK_URL.";
    }
    async getLocationIfAvailable(session) {
        try {
            return await session.location.getLatestLocation({ accuracy: "standard" });
        }
        catch {
            return undefined;
        }
    }
    async respond(record, reply, title = "Cally") {
        const shortReply = this.cleanReply(reply);
        record.lastReply = shortReply;
        this.showCard(record, title, shortReply, 12000);
        if (SPEAK_REPLIES && record.mode !== "quiet")
            await this.safeSpeak(record, shortReply);
    }
    canUseDisplay(record) {
        if (!USE_DISPLAY)
            return false;
        const capabilities = record.session.capabilities;
        if (capabilities?.hasDisplay === false)
            return false;
        return true;
    }
    showText(record, text, durationMs) {
        if (!this.canUseDisplay(record))
            return;
        try {
            record.session.layouts.showTextWall(text, durationMs ? { durationMs } : undefined);
        }
        catch (error) {
            record.session.logger.warn({ error }, "Display text failed");
        }
    }
    showCard(record, title, text, durationMs) {
        if (!this.canUseDisplay(record))
            return;
        try {
            record.session.layouts.showDoubleTextWall(title, text, durationMs ? { durationMs } : undefined);
        }
        catch (error) {
            record.session.logger.warn({ error }, "Display card failed");
        }
    }
    clearDisplay(record) {
        if (!this.canUseDisplay(record))
            return;
        try {
            record.session.layouts.clearView();
        }
        catch (error) {
            record.session.logger.warn({ error }, "Display clear failed");
        }
    }
    async safeSpeak(record, text) {
        try {
            if (record.session.capabilities && record.session.capabilities.hasSpeaker === false)
                return;
            await record.session.audio.speak(text);
        }
        catch (error) {
            record.session.logger.warn({ error }, "TTS failed");
        }
    }
    async blink(record, color) {
        if (!LED_FEEDBACK)
            return;
        try {
            if (record.session.capabilities?.hasLight === false)
                return;
            await record.session.led.blink(color, 120, 80, 2);
        }
        catch {
            // LED support varies by device; display/audio still matter more.
        }
    }
    formatStatus(record) {
        const device = record.device;
        const battery = device.batteryLevel == null ? "battery unknown" : `glasses ${device.batteryLevel}%${device.charging ? " charging" : ""}`;
        const phone = device.phoneBatteryLevel == null ? "phone unknown" : `phone ${device.phoneBatteryLevel}%${device.phoneCharging ? " charging" : ""}`;
        const wifi = device.wifiConnected ? `WiFi ${device.wifiSsid || "connected"}` : "WiFi unknown/off";
        const bridge = CALLY_AGENT_WEBHOOK_URL ? "agent bridge on" : "agent bridge off";
        return `${battery}. ${phone}. ${wifi}. Mode ${record.mode}. ${bridge}.`;
    }
    formatDateTime() {
        return new Intl.DateTimeFormat("en-US", {
            timeZone: process.env.CALLY_TIMEZONE || "America/Los_Angeles",
            weekday: "long",
            hour: "numeric",
            minute: "2-digit",
            month: "long",
            day: "numeric",
        }).format(new Date());
    }
    snapshotDevice(session) {
        const state = session.device.state.getSnapshot();
        return {
            modelName: state.modelName,
            wifiConnected: state.wifiConnected,
            wifiSsid: state.wifiSsid,
            wifiLocalIp: state.wifiLocalIp,
            hotspotEnabled: state.hotspotEnabled,
            batteryLevel: state.batteryLevel,
            charging: state.charging,
            glassesConnected: state.connected,
        };
    }
    publicSession(record) {
        return {
            sessionId: record.sessionId,
            userId: record.userId,
            connectedAt: record.connectedAt,
            mode: record.mode,
            lastTranscript: record.lastTranscript,
            lastReply: record.lastReply,
            lastEvent: record.lastEvent,
            device: record.device,
            notes: record.notes.slice(-10),
            recentTranscripts: record.transcriptHistory.slice(-10),
        };
    }
    async loadNotes(record) {
        try {
            const raw = await record.session.simpleStorage.get("cally_notes");
            if (!raw)
                return;
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed))
                record.notes = parsed.filter((item) => typeof item === "string").slice(-20);
        }
        catch {
            record.notes = [];
        }
    }
    async saveNotes(record) {
        try {
            await record.session.simpleStorage.set("cally_notes", JSON.stringify(record.notes.slice(-20)));
        }
        catch (error) {
            record.session.logger.warn({ error }, "Failed to save notes");
        }
    }
    cleanupSession(sessionId) {
        const record = this.sessions.get(sessionId);
        if (!record)
            return;
        for (const cleanup of record.cleanup) {
            try {
                cleanup();
            }
            catch {
                // Best-effort stream cleanup.
            }
        }
        this.sessions.delete(sessionId);
    }
    pushLimited(list, item, limit) {
        list.push(item);
        if (list.length > limit)
            list.splice(0, list.length - limit);
    }
    cleanReply(reply) {
        const normalized = reply.replace(/\s+/g, " ").trim();
        return normalized.length > 450 ? `${normalized.slice(0, 447)}...` : normalized;
    }
    requireSession(sessionId) {
        const record = this.sessions.get(sessionId);
        if (!record)
            throw new SessionNotFoundError(sessionId);
        return record;
    }
    authorized(req) {
        if (!CONTROL_TOKEN)
            return true;
        const header = String(req.headers.authorization || "");
        const token = header.replace(/^Bearer\s+/i, "") || String(req.query?.token || "");
        return token === CONTROL_TOKEN;
    }
    async routeAsync(res, fn) {
        try {
            const result = await fn();
            // A handler may have already responded (e.g. an auth 401). res.json()
            // returns the Response object, so guard on headersSent to avoid the
            // "headers already sent" double-send that this used to trigger.
            if (result !== undefined && !res.headersSent)
                res.json(result);
        }
        catch (error) {
            if (res.headersSent)
                return;
            if (error instanceof zod_1.z.ZodError) {
                res.status(400).json({ error: "invalid_request", details: error.issues });
                return;
            }
            if (error instanceof SessionNotFoundError) {
                res.status(404).json({ error: error.message });
                return;
            }
            this.logger.error({ error: this.shortError(error) }, "Control route failed");
            res.status(500).json({ error: this.shortError(error) });
        }
    }
}
const server = new CallyMentraApp({
    packageName: PACKAGE_NAME,
    apiKey: MENTRAOS_API_KEY,
    port: PORT,
});
server.wireControlEndpoints();
server.start()
    .then(() => {
    console.log(`Cally Mentra app listening on port ${PORT}`);
    const bridge = CALLY_AGENT_WEBHOOK_URL
        ? "webhook"
        : CALLY_AGENT_CLI_ENABLED
            ? `local CLI (${CALLY_AGENT_CLI_PATH})`
            : "local fallback only";
    console.log(`Cally agent bridge: ${bridge}`);
})
    .catch((error) => {
    console.error("Cally Mentra app failed to start:", error);
    process.exit(1);
});
