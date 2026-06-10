import "dotenv/config";
import {
  AppServer,
  AppSession,
  ButtonPress,
  GlassesBatteryUpdate,
  GlassesConnectionState,
  LocationUpdate,
  PhoneBatteryUpdate,
  PhoneNotification,
  PhotoData,
  TouchEvent,
  TranscriptionData,
} from "@mentra/sdk";
import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  LoseFitStore,
  formatLoggedEntry,
  formatSummary,
  isLoseFitLogCommand,
  isLoseFitSummaryCommand,
} from "./losefit";
import { callAgentCli } from "./agent-cli";
import { ackChimeWav } from "./sound";

const PORT = parseInt(process.env.PORT || "3017", 10);
const PACKAGE_NAME = process.env.PACKAGE_NAME || "com.mukil.cally";
const MENTRAOS_API_KEY = process.env.MENTRAOS_API_KEY;
const CONTROL_TOKEN = process.env.CALLY_MENTRA_CONTROL_TOKEN || "";
const CALLY_AGENT_WEBHOOK_URL = process.env.CALLY_AGENT_WEBHOOK_URL || "";
const CALLY_AGENT_BEARER_TOKEN = process.env.CALLY_AGENT_BEARER_TOKEN || "";
// Local OpenClaw CLI bridge: used when no webhook URL is configured so the
// local setup still gets full Cally reasoning without standing up an HTTP gateway.
const CALLY_AGENT_CLI_ENABLED = (process.env.CALLY_AGENT_CLI_ENABLED || "true").toLowerCase() !== "false";
const CALLY_AGENT_CLI_PATH = process.env.CALLY_AGENT_CLI_PATH || "openclaw";
const CALLY_AGENT_CLI_TIMEOUT_SECONDS = Math.max(
  5,
  parseInt(process.env.CALLY_AGENT_CLI_TIMEOUT_SECONDS || "45", 10) || 45,
);
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
// Debounce so a single spoken request (which streams many interim transcripts)
// only chirps once.
const ACK_DEBOUNCE_MS = 3500;
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
console.error = (...args: unknown[]): void => {
  const first = args[0];
  if (typeof first === "string" && first.startsWith("Frontend token verification failed:")) {
    suppressedFrontendTokenWarnings += 1;
    return;
  }
  originalConsoleError(...(args as []));
};
const frontendTokenWarningTimer = setInterval(() => {
  if (suppressedFrontendTokenWarnings > 0) {
    originalConsoleError(
      `[cally-mentra] Suppressed ${suppressedFrontendTokenWarnings} benign "invalid frontend token format" warning(s) from @mentra/sdk in the last minute.`,
    );
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

type SessionMode = "assist" | "captions" | "quiet";

type DeviceSnapshot = {
  modelName?: string | null;
  wifiConnected?: boolean | null;
  wifiSsid?: string | null;
  wifiLocalIp?: string | null;
  hotspotEnabled?: boolean | null;
  batteryLevel?: number | null;
  charging?: boolean | null;
  phoneBatteryLevel?: number | null;
  phoneCharging?: boolean | null;
  glassesConnected?: boolean | null;
  lastLocation?: Pick<LocationUpdate, "lat" | "lng" | "accuracy">;
};

type SessionRecord = {
  session: AppSession;
  sessionId: string;
  userId: string;
  connectedAt: string;
  mode: SessionMode;
  lastTranscript?: string;
  lastReply?: string;
  lastEvent?: string;
  lastAckAt?: number;
  transcriptHistory: string[];
  notes: string[];
  device: DeviceSnapshot;
  cleanup: Array<() => void>;
};

type CallyBridgePayload = {
  kind: "voice" | "photo" | "control";
  userId: string;
  sessionId: string;
  text: string;
  location?: unknown;
  device?: DeviceSnapshot;
  recentTranscripts?: string[];
  notes?: string[];
  photo?: {
    mimeType: string;
    filename: string;
    base64: string;
    size: number;
  };
};

const saySchema = z.object({
  text: z.string().min(1),
  speak: z.boolean().optional(),
});

const commandSchema = z.object({
  text: z.string().min(1),
});

const captureSchema = z.object({
  prompt: z.string().default("What am I looking at?"),
  size: z.enum(["small", "medium", "large", "full"]).default("medium"),
});

const modeSchema = z.object({
  mode: z.enum(["assist", "captions", "quiet"]),
});

/** Thrown when a control route targets a session id that is not connected. */
class SessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`No active session: ${sessionId}`);
    this.name = "SessionNotFoundError";
  }
}

function renderWebviewHtml(): string {
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

class CallyMentraApp extends AppServer {
  private sessions = new Map<string, SessionRecord>();
  private loseFit = new LoseFitStore();

  protected async onSession(session: AppSession, sessionId: string, userId: string): Promise<void> {
    const record: SessionRecord = {
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

    session.events.onTranscription((data: TranscriptionData) => {
      void this.handleTranscription(sessionId, data);
    });

    session.events.onDisconnected(() => {
      this.cleanupSession(sessionId);
    });

    session.logger.info({ sessionId, userId }, "Cally Mentra session started");
    this.showReady(record);
  }

  protected async onStop(sessionId: string, userId: string, reason: string): Promise<void> {
    this.cleanupSession(sessionId);
    this.logger.info({ sessionId, userId, reason }, "Cally Mentra session stopped");
  }

  protected async onToolCall(toolCall: any): Promise<string | undefined> {
    const userId = String(toolCall.userId || toolCall.user_id || "");
    const text = String(toolCall.args?.text || toolCall.text || "");
    const record = [...this.sessions.values()].find((item) => item.userId === userId) || [...this.sessions.values()][0];
    if (!record || !text) return "Cally is not connected to an active glasses session.";
    const reply = await this.handleCommand(record, text, "tool");
    return reply;
  }

  public wireControlEndpoints(): void {
    const app = this.getExpressApp();

    app.get("/", (_req: Request, res: Response) => {
      res.redirect(302, "/webview");
    });

    app.get("/webview", (_req: Request, res: Response) => {
      res
        .setHeader("content-security-policy", "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors *")
        .type("html")
        .send(renderWebviewHtml());
    });

    app.get("/assets/cally-ack.wav", (_req: Request, res: Response) => {
      res
        .setHeader("cache-control", "public, max-age=86400")
        .type("audio/wav")
        .send(ackChimeWav());
    });

    app.get("/health", (_req: Request, res: Response) => {
      res.json({
        ok: true,
        app: "cally-mentra",
        packageName: PACKAGE_NAME,
        sessions: this.sessions.size,
        bridgeConfigured: Boolean(CALLY_AGENT_WEBHOOK_URL),
      });
    });

    app.get("/status", (req: Request, res: Response) => {
      if (!this.authorized(req)) return res.status(401).json({ error: "unauthorized" });
      res.json({
        ok: true,
        sessions: [...this.sessions.values()].map((item) => this.publicSession(item)),
      });
    });

    app.get("/sessions", (req: Request, res: Response) => {
      if (!this.authorized(req)) return res.status(401).json({ error: "unauthorized" });
      res.json({
        sessions: [...this.sessions.values()].map((item) => this.publicSession(item)),
      });
    });

    app.post("/sessions/:sessionId/say", (req: Request, res: Response) => {
      void this.routeAsync(res, async () => {
        if (!this.authorized(req)) return res.status(401).json({ error: "unauthorized" });
        const record = this.requireSession(String(req.params.sessionId));
        const body = saySchema.parse(req.body);
        this.showText(record, body.text);
        if (body.speak ?? true) await this.safeSpeak(record, body.text);
        return { ok: true };
      });
    });

    app.post("/sessions/:sessionId/command", (req: Request, res: Response) => {
      void this.routeAsync(res, async () => {
        if (!this.authorized(req)) return res.status(401).json({ error: "unauthorized" });
        const record = this.requireSession(String(req.params.sessionId));
        const body = commandSchema.parse(req.body);
        const reply = await this.handleCommand(record, body.text, "control");
        return { ok: true, reply };
      });
    });

    app.post("/sessions/:sessionId/mode", (req: Request, res: Response) => {
      void this.routeAsync(res, async () => {
        if (!this.authorized(req)) return res.status(401).json({ error: "unauthorized" });
        const record = this.requireSession(String(req.params.sessionId));
        const body = modeSchema.parse(req.body);
        record.mode = body.mode;
        const reply = `Mode set to ${body.mode}.`;
        await this.respond(record, reply);
        return { ok: true, mode: record.mode };
      });
    });

    app.post("/sessions/:sessionId/capture", (req: Request, res: Response) => {
      void this.routeAsync(res, async () => {
        if (!this.authorized(req)) return res.status(401).json({ error: "unauthorized" });
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
    app.use((req: Request, res: Response) => {
      res.status(404).json({ error: "not_found", path: req.path });
    });

    app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
      this.logger.error({ error: this.shortError(err), path: req.path }, "Unhandled control-route error");
      if (res.headersSent) return next(err);
      res.status(500).json({ error: this.shortError(err) });
    });
  }

  private wireSessionEvents(record: SessionRecord): void {
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

    if (!ADVANCED_STREAMS) return;

    record.cleanup.push(session.events.onButtonPress((data) => void this.handleButton(record, data)));
    record.cleanup.push(session.events.onTouchEvent((data) => void this.handleTouch(record, data)));
    record.cleanup.push(session.events.onGlassesBattery((data) => this.handleGlassesBattery(record, data)));
    record.cleanup.push(session.events.onPhoneBattery((data) => this.handlePhoneBattery(record, data)));
    record.cleanup.push(session.events.onLocation((data) => this.handleLocation(record, data)));
    record.cleanup.push(session.events.onPhoneNotifications((data) => void this.handlePhoneNotification(record, data)));
    record.cleanup.push(session.events.on<"glasses_connection_state">("glasses_connection_state", (data) => this.handleConnectionState(record, data as GlassesConnectionState)));
    const cleanupCapabilities = session.events.onCapabilitiesUpdate((data) => {
      record.device.modelName = data.modelName;
      record.lastEvent = "Capabilities updated";
    });
    record.cleanup.push(() => {
      cleanupCapabilities();
    });
  }

  private showReady(record: SessionRecord): void {
    this.showText(record, "Cally ready. Say: Cally help.", 8000);
    if (SPEAK_ON_STARTUP) void this.safeSpeak(record, "Cally is ready.");
  }

  private async handleTranscription(sessionId: string, data: TranscriptionData): Promise<void> {
    const record = this.sessions.get(sessionId);
    if (!record) return;

    const text = data.text.trim();
    if (!text) return;

    // Acknowledge the wake word the instant it appears — even in an interim
    // (non-final) transcript — so the wearer gets an immediate chirp instead of
    // waiting out the full final transcript plus the agent turn.
    if (this.extractWakeCommand(text)) {
      this.acknowledgeWake(record);
    }

    if (!data.isFinal) return;

    record.lastTranscript = text;
    this.pushLimited(record.transcriptHistory, text, 30);

    const command = this.extractWakeCommand(text);
    if (!command) {
      if (record.mode === "captions") {
        this.showText(record, text, 8000);
      }
      return;
    }

    this.showText(record, "Thinking...", 3000);
    await this.handleCommand(record, command, "voice");
  }

  /** Immediate feedback that the wake word was heard, before the reply is ready. */
  private acknowledgeWake(record: SessionRecord): void {
    const now = Date.now();
    if (record.lastAckAt && now - record.lastAckAt < ACK_DEBOUNCE_MS) return;
    record.lastAckAt = now;
    this.showText(record, "Cally listening…", 2500);
    if (CALLY_ACK_SOUND) void this.playAckChime(record);
  }

  private async playAckChime(record: SessionRecord): Promise<void> {
    if (!CALLY_PUBLIC_URL) return;
    try {
      if (record.session.capabilities && record.session.capabilities.hasSpeaker === false) return;
      // Non-blocking (stopOtherAudio:false) so the chime never delays the turn
      // and never cuts off the spoken reply, which plays on a different track.
      await record.session.audio.playAudio({
        audioUrl: `${CALLY_PUBLIC_URL}/assets/cally-ack.wav`,
        volume: 0.6,
        stopOtherAudio: false,
      });
    } catch (error) {
      record.session.logger.warn({ error: this.shortError(error) }, "Wake-word chime failed");
    }
  }

  private extractWakeCommand(text: string): string | null {
    const match = text.match(/\b(cally|kali|callie|hey cally|hey kali)\b[:,]?\s*(.*)$/i);
    if (!match) return null;
    return (match[2] || "help").trim();
  }

  private async handleCommand(record: SessionRecord, rawCommand: string, origin: "voice" | "control" | "tool"): Promise<string> {
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
    if (loseFitReply) return loseFitReply;

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

  private async handleLoseFitCommand(record: SessionRecord, command: string, origin: "voice" | "control" | "tool"): Promise<string | null> {
    const source = origin === "voice" ? "mentra" : origin;

    if (isLoseFitSummaryCommand(command)) {
      const reply = formatSummary(await this.loseFit.summaryForLocalDate());
      await this.respond(record, reply, "LoseFit");
      return reply;
    }

    if (/\b(lose\s*(it|fit))\b.*\b(export|csv)\b/i.test(command)) {
      const csvPath = await this.loseFit.exportCsv();
      const reply = `LoseFit CSV exported: ${csvPath}`;
      await this.respond(record, reply, "LoseFit");
      return reply;
    }

    if (isLoseFitLogCommand(command)) {
      const entry = await this.loseFit.log(command, source);
      const reply = formatLoggedEntry(entry);
      await this.respond(record, reply, "LoseFit");
      return reply;
    }

    return null;
  }

  private async handleButton(record: SessionRecord, data: ButtonPress): Promise<void> {
    record.lastEvent = `${data.buttonId} ${data.pressType} press`;
    if (data.pressType === "long") {
      const reply = await this.captureAndAsk(record, "What am I looking at?", "medium");
      await this.respond(record, reply, "Long Press");
      return;
    }
    await this.respond(record, this.formatStatus(record), "Status");
  }

  private async handleTouch(record: SessionRecord, data: TouchEvent): Promise<void> {
    record.lastEvent = `Touch: ${data.gesture_name}`;
    if (/forward|tap|single/i.test(data.gesture_name)) {
      await this.respond(record, "Cally ready. Say help, status, or look.", "Ready");
    } else if (/back|long/i.test(data.gesture_name)) {
      this.clearDisplay(record);
    }
  }

  private handleGlassesBattery(record: SessionRecord, data: GlassesBatteryUpdate): void {
    record.device.batteryLevel = data.level;
    record.device.charging = data.charging;
    record.lastEvent = `Glasses battery ${data.level}%`;
  }

  private handlePhoneBattery(record: SessionRecord, data: PhoneBatteryUpdate): void {
    record.device.phoneBatteryLevel = data.level;
    record.device.phoneCharging = data.charging;
  }

  private handleConnectionState(record: SessionRecord, data: GlassesConnectionState): void {
    record.device.modelName = data.modelName;
    record.device.glassesConnected = data.status === "connected";
    record.device.wifiConnected = data.wifi?.connected ?? record.device.wifiConnected;
    record.device.wifiSsid = data.wifi?.ssid ?? record.device.wifiSsid;
    record.lastEvent = `Connection: ${data.status}`;
  }

  private handleLocation(record: SessionRecord, data: LocationUpdate): void {
    record.device.lastLocation = {
      lat: data.lat,
      lng: data.lng,
      accuracy: data.accuracy,
    };
  }

  private async handlePhoneNotification(record: SessionRecord, data: PhoneNotification): Promise<void> {
    if (data.priority !== "high") return;
    const content = `${data.app}: ${data.title}`.slice(0, 180);
    this.showCard(record, "Notification", content, 9000);
  }

  private async captureAndAsk(record: SessionRecord, prompt: string, size: "small" | "medium" | "large" | "full"): Promise<string> {
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
    } catch (error) {
      session.logger.error({ error: this.shortError(error) }, "Photo capture failed");
      return "I could not capture a photo from the glasses.";
    }
  }

  /**
   * Persists a captured frame under CAPTURE_DIR so the local agent bridge can
   * reference it by path. Best-effort: a storage failure must not break the
   * reply flow, so we log and return undefined rather than throwing.
   */
  private async savePhoto(record: SessionRecord, photo: PhotoData): Promise<string | undefined> {
    try {
      await fs.mkdir(CAPTURE_DIR, { recursive: true });
      const ext = this.extensionForMime(photo.mimeType);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `${stamp}-${this.sanitizeKeySegment(record.userId)}${ext}`;
      const fullPath = path.join(CAPTURE_DIR, filename);
      await fs.writeFile(fullPath, photo.buffer);
      return fullPath;
    } catch (error) {
      record.session.logger.warn({ error: this.shortError(error) }, "Failed to save captured photo");
      return undefined;
    }
  }

  private extensionForMime(mimeType: string): string {
    if (/png/i.test(mimeType)) return ".png";
    if (/webp/i.test(mimeType)) return ".webp";
    if (/jpe?g/i.test(mimeType)) return ".jpg";
    return ".bin";
  }

  private async askCally(
    record: SessionRecord,
    input: { kind: "voice" | "photo" | "control"; text: string; location?: unknown; photo?: PhotoData; photoPath?: string },
  ): Promise<string> {
    if (CALLY_AGENT_WEBHOOK_URL) {
      try {
        return await this.askViaWebhook(record, input);
      } catch (error) {
        record.session.logger.error(
          { error: this.shortError(error), kind: input.kind },
          "Cally webhook bridge failed",
        );
        return "I could not reach the Cally bridge just now.";
      }
    }

    if (CALLY_AGENT_CLI_ENABLED) {
      return this.askViaCli(record, input);
    }

    return this.localReply(record, input);
  }

  private async askViaWebhook(
    record: SessionRecord,
    input: { kind: "voice" | "photo" | "control"; text: string; location?: unknown; photo?: PhotoData },
  ): Promise<string> {
    const payload: CallyBridgePayload = {
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

    const json = (await response.json()) as { reply?: unknown; text?: unknown; message?: unknown };
    return this.cleanReply(String(json.reply || json.text || json.message || "Done."));
  }

  private async askViaCli(
    record: SessionRecord,
    input: { kind: "voice" | "photo" | "control"; text: string; location?: unknown; photoPath?: string },
  ): Promise<string> {
    const sessionKey = `${CALLY_AGENT_SESSION_PREFIX}:${this.sanitizeKeySegment(record.userId)}`;
    const message = this.buildCliMessage(record, input);

    const result = await callAgentCli({
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
      record.session.logger.error(
        { error: result.error, kind: input.kind, sessionKey },
        "Cally CLI bridge failed",
      );
      return "Cally is having trouble reasoning right now. Try again in a moment.";
    }

    return this.cleanReply(result.text);
  }

  private buildCliMessage(
    record: SessionRecord,
    input: { kind: "voice" | "photo" | "control"; text: string; photoPath?: string },
  ): string {
    const lines = [input.text.trim()];
    if (input.kind === "photo") {
      lines.push(
        input.photoPath
          ? `[A photo was just captured from the glasses and saved locally at ${input.photoPath}. Use it to answer the request above; keep the reply short for a heads-up display.]`
          : "[A photo was just captured from the glasses but could not be saved to disk. Answer the request above as best you can.]",
      );
    }
    const recent = record.transcriptHistory.slice(-3).filter((line) => line && line !== input.text);
    if (recent.length) {
      lines.push(`[Recent speech for context: ${recent.join(" | ")}]`);
    }
    return lines.join("\n");
  }

  private sanitizeKeySegment(value: string): string {
    const cleaned = (value || "").replace(/[^A-Za-z0-9_.-]/g, "-").replace(/^-+|-+$/g, "");
    return cleaned || "unknown";
  }

  private shortError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.length > 300 ? `${message.slice(0, 299)}…` : message;
  }

  private localReply(record: SessionRecord, input: { kind: "voice" | "photo" | "control"; text: string }): string {
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

  private async getLocationIfAvailable(session: AppSession): Promise<unknown> {
    try {
      return await session.location.getLatestLocation({ accuracy: "standard" });
    } catch {
      return undefined;
    }
  }

  private async respond(record: SessionRecord, reply: string, title = "Cally"): Promise<void> {
    const shortReply = this.cleanReply(reply);
    record.lastReply = shortReply;
    this.showCard(record, title, shortReply, 12000);
    if (SPEAK_REPLIES && record.mode !== "quiet") await this.safeSpeak(record, shortReply);
  }

  private canUseDisplay(record: SessionRecord): boolean {
    if (!USE_DISPLAY) return false;
    const capabilities = record.session.capabilities as Record<string, unknown> | null;
    if (capabilities?.hasDisplay === false) return false;
    return true;
  }

  private showText(record: SessionRecord, text: string, durationMs?: number): void {
    if (!this.canUseDisplay(record)) return;
    try {
      record.session.layouts.showTextWall(text, durationMs ? { durationMs } : undefined);
    } catch (error) {
      record.session.logger.warn({ error }, "Display text failed");
    }
  }

  private showCard(record: SessionRecord, title: string, text: string, durationMs?: number): void {
    if (!this.canUseDisplay(record)) return;
    try {
      record.session.layouts.showDoubleTextWall(title, text, durationMs ? { durationMs } : undefined);
    } catch (error) {
      record.session.logger.warn({ error }, "Display card failed");
    }
  }

  private clearDisplay(record: SessionRecord): void {
    if (!this.canUseDisplay(record)) return;
    try {
      record.session.layouts.clearView();
    } catch (error) {
      record.session.logger.warn({ error }, "Display clear failed");
    }
  }

  private async safeSpeak(record: SessionRecord, text: string): Promise<void> {
    try {
      if (record.session.capabilities && record.session.capabilities.hasSpeaker === false) return;
      await record.session.audio.speak(text);
    } catch (error) {
      record.session.logger.warn({ error }, "TTS failed");
    }
  }

  private async blink(record: SessionRecord, color: "blue" | "green" | "red" | "white"): Promise<void> {
    if (!LED_FEEDBACK) return;
    try {
      if (record.session.capabilities?.hasLight === false) return;
      await record.session.led.blink(color, 120, 80, 2);
    } catch {
      // LED support varies by device; display/audio still matter more.
    }
  }

  private formatStatus(record: SessionRecord): string {
    const device = record.device;
    const battery = device.batteryLevel == null ? "battery unknown" : `glasses ${device.batteryLevel}%${device.charging ? " charging" : ""}`;
    const phone = device.phoneBatteryLevel == null ? "phone unknown" : `phone ${device.phoneBatteryLevel}%${device.phoneCharging ? " charging" : ""}`;
    const wifi = device.wifiConnected ? `WiFi ${device.wifiSsid || "connected"}` : "WiFi unknown/off";
    const bridge = CALLY_AGENT_WEBHOOK_URL ? "agent bridge on" : "agent bridge off";
    return `${battery}. ${phone}. ${wifi}. Mode ${record.mode}. ${bridge}.`;
  }

  private snapshotDevice(session: AppSession): DeviceSnapshot {
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

  private publicSession(record: SessionRecord): Record<string, unknown> {
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

  private async loadNotes(record: SessionRecord): Promise<void> {
    try {
      const raw = await record.session.simpleStorage.get("cally_notes");
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) record.notes = parsed.filter((item) => typeof item === "string").slice(-20);
    } catch {
      record.notes = [];
    }
  }

  private async saveNotes(record: SessionRecord): Promise<void> {
    try {
      await record.session.simpleStorage.set("cally_notes", JSON.stringify(record.notes.slice(-20)));
    } catch (error) {
      record.session.logger.warn({ error }, "Failed to save notes");
    }
  }

  private cleanupSession(sessionId: string): void {
    const record = this.sessions.get(sessionId);
    if (!record) return;
    for (const cleanup of record.cleanup) {
      try {
        cleanup();
      } catch {
        // Best-effort stream cleanup.
      }
    }
    this.sessions.delete(sessionId);
  }

  private pushLimited<T>(list: T[], item: T, limit: number): void {
    list.push(item);
    if (list.length > limit) list.splice(0, list.length - limit);
  }

  private cleanReply(reply: string): string {
    const normalized = reply.replace(/\s+/g, " ").trim();
    return normalized.length > 450 ? `${normalized.slice(0, 447)}...` : normalized;
  }

  private requireSession(sessionId: string): SessionRecord {
    const record = this.sessions.get(sessionId);
    if (!record) throw new SessionNotFoundError(sessionId);
    return record;
  }

  private authorized(req: { headers: Record<string, unknown>; query?: Record<string, unknown> }): boolean {
    if (!CONTROL_TOKEN) return true;
    const header = String(req.headers.authorization || "");
    const token = header.replace(/^Bearer\s+/i, "") || String(req.query?.token || "");
    return token === CONTROL_TOKEN;
  }

  private async routeAsync(
    res: { json: (body: unknown) => void; status: (code: number) => any; headersSent: boolean },
    fn: () => Promise<unknown>,
  ): Promise<void> {
    try {
      const result = await fn();
      // A handler may have already responded (e.g. an auth 401). res.json()
      // returns the Response object, so guard on headersSent to avoid the
      // "headers already sent" double-send that this used to trigger.
      if (result !== undefined && !res.headersSent) res.json(result);
    } catch (error) {
      if (res.headersSent) return;
      if (error instanceof z.ZodError) {
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
