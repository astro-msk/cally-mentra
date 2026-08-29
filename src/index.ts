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
import { readFileSync } from "node:fs";
import type { Server as HttpServer } from "node:http";
import * as path from "node:path";
import {
  LoseFitStore,
  formatLoggedEntry,
  formatSummary,
  isLoseFitLogCommand,
  isLoseFitSummaryCommand,
} from "./losefit";
import { callAgentCli } from "./agent-cli";
import { callOpenAi, type OpenAiBridgeConfig } from "./openai-bridge";
import { ackChimeWav } from "./sound";
import { extractWakeCommand as matchWakeCommand, parseExtraVariants, type WakeOptions } from "./wake";
import * as os from "node:os";
import {
  DirectGlassesGateway,
  createDirectGlassesBearerAuthorizer,
  directGlassesConfigFromEnv,
  registerDirectGlassesHttpRoutes,
} from "./direct-glasses";
import {
  cloudflareAccessConfigFromEnv,
  createCloudflareAccessUpgradeAuthenticator,
} from "./cloudflare-access";

const PORT = parseInt(process.env.PORT || "3017", 10);
const PACKAGE_NAME = process.env.PACKAGE_NAME || "com.mukil.cally";
const MENTRAOS_API_KEY = process.env.MENTRAOS_API_KEY;
const CONTROL_TOKEN = process.env.CALLY_MENTRA_CONTROL_TOKEN || "";
const CALLY_COOKIE_SECRET = process.env.CALLY_COOKIE_SECRET || "";
const controlAuthorized = createDirectGlassesBearerAuthorizer(CONTROL_TOKEN);
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
// Override the chime with any glasses-reachable audio URL; defaults to the MP3
// this app serves at /assets/cally-ack.mp3.
const CALLY_ACK_SOUND_URL = process.env.CALLY_ACK_SOUND_URL
  || (CALLY_PUBLIC_URL ? `${CALLY_PUBLIC_URL}/assets/cally-ack.mp3` : "");
const CALLY_ACK_VOLUME = clampEnvNumber("CALLY_ACK_VOLUME", 0.28, 0, 1);
// Speech-to-text language. Indian English ("en-IN") recognises the wake word and
// accented speech far better than the default US English for that accent.
const CALLY_TRANSCRIBE_LANGUAGE = process.env.CALLY_TRANSCRIBE_LANGUAGE || "en-US";
// Wake-word tuning: extra accepted spellings + fuzzy phonetic matching.
const CALLY_WAKE_WORDS = process.env.CALLY_WAKE_WORDS || "";
const CALLY_WAKE_FUZZY = (process.env.CALLY_WAKE_FUZZY || "true").toLowerCase() !== "false";
const SPEAK_REPLIES = (process.env.CALLY_SPEAK_REPLIES || "true").toLowerCase() !== "false";
// MentraOS TTS is ElevenLabs-backed. Use a softer voice/settings profile by
// default; keep everything env-tunable so we can quickly adjust after Mukil
// hears it on the actual glasses.
const CALLY_TTS_VOICE_ID = process.env.CALLY_TTS_VOICE_ID || "EXAVITQu4vr4xnSDxMaL"; // Sarah: softer/warmer than the platform default.
const CALLY_TTS_MODEL_ID = process.env.CALLY_TTS_MODEL_ID || "eleven_flash_v2_5";
const CALLY_TTS_VOLUME = clampEnvNumber("CALLY_TTS_VOLUME", 0.78, 0, 1);
const CALLY_TTS_STABILITY = clampEnvNumber("CALLY_TTS_STABILITY", 0.72, 0, 1);
const CALLY_TTS_SIMILARITY = clampEnvNumber("CALLY_TTS_SIMILARITY", 0.82, 0, 1);
const CALLY_TTS_STYLE = clampEnvNumber("CALLY_TTS_STYLE", 0.18, 0, 1);
const CALLY_TTS_SPEED = clampEnvNumber("CALLY_TTS_SPEED", 0.94, 0.7, 1.2);
const CALLY_TTS_SPEAKER_BOOST = (process.env.CALLY_TTS_SPEAKER_BOOST || "false").toLowerCase() === "true";
const SPEAK_ON_STARTUP = (process.env.CALLY_MENTRA_SPEAK_ON_STARTUP || "false").toLowerCase() === "true";
const LED_FEEDBACK = (process.env.CALLY_MENTRA_LED_FEEDBACK || "false").toLowerCase() === "true";
const ADVANCED_STREAMS = (process.env.CALLY_MENTRA_ADVANCED_STREAMS || "false").toLowerCase() === "true";
const USE_DISPLAY = (process.env.CALLY_MENTRA_USE_DISPLAY || "false").toLowerCase() === "true";

function clampEnvNumber(name: string, fallback: number, min: number, max: number): number {
  const value = parseFloat(process.env[name] || "");
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

if (!MENTRAOS_API_KEY) {
  console.error("MENTRAOS_API_KEY is required. Copy .env.example to .env and configure it.");
  process.exit(1);
}
if (process.env.NODE_ENV === "production" && Buffer.byteLength(CALLY_COOKIE_SECRET) < 32) {
  console.error("CALLY_COOKIE_SECRET must contain at least 32 bytes in production.");
  process.exit(1);
}
if (process.env.NODE_ENV === "production"
    && CONTROL_TOKEN
    && Buffer.byteLength(CONTROL_TOKEN) < 32) {
  console.error("CALLY_MENTRA_CONTROL_TOKEN must contain at least 32 bytes in production.");
  process.exit(1);
}

// --- Quiet a known-benign, self-recovered log line from @mentra/sdk ---------
// The SDK registers a global auth middleware that calls verifyFrontendToken()
// on every request. When a MentraOS webview request arrives with a frontend
// token that is not in the SDK's `userId:hash` form, that function throws
// internally, console.error()s "Frontend token verification failed: ...", and
// then catches it; our protected routes still perform strict bearer authentication. The token is
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

let ackMp3Cache: Buffer | null | undefined;
/** Loads the bundled MP3 chime once. Returns null if the asset is missing. */
function ackChimeMp3(): Buffer | null {
  if (ackMp3Cache !== undefined) return ackMp3Cache;
  const candidates = [
    path.resolve(process.cwd(), "assets/cally-ack.mp3"),
    path.resolve(__dirname, "../assets/cally-ack.mp3"),
  ];
  for (const candidate of candidates) {
    try {
      ackMp3Cache = readFileSync(candidate);
      return ackMp3Cache;
    } catch {
      // try next candidate
    }
  }
  ackMp3Cache = null;
  return ackMp3Cache;
}

function renderWebviewHtml(): string {
  const voiceEngine = CALLY_OPENAI_ENABLED
    ? `${CALLY_OPENAI_MODEL} · fast`
    : CALLY_AGENT_CLI_ENABLED
      ? "openclaw agent"
      : "local";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="theme-color" content="#f7f5f1" media="(prefers-color-scheme: light)" />
    <meta name="theme-color" content="#1c1a17" media="(prefers-color-scheme: dark)" />
    <title>Cally</title>
    <style>
      :root {
        color-scheme: light dark;
        --bg: #f6f3ee;
        --bg-glow: #efe9e0;
        --surface: #fffdfa;
        --surface-soft: #faf7f2;
        --border: #e9e2d7;
        --border-strong: #ddd4c6;
        --text: #211f1b;
        --muted: #6f675b;
        --faint: #a59c8e;
        --accent: #c15f3c;
        --accent-soft: #f1e3da;
        --accent-ink: #ffffff;
        --ok: #5f8c57;
        --warn: #bf8a3c;
        --shadow: 0 1px 2px rgba(40, 32, 22, 0.04), 0 8px 24px -12px rgba(40, 32, 22, 0.14);
        --radius: 16px;
        --radius-sm: 11px;
        --sans: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
        --serif: "Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, ui-serif, serif;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --bg: #1b1916;
          --bg-glow: #221f1a;
          --surface: #252118;
          --surface-soft: #2b261d;
          --border: #38322a;
          --border-strong: #443d33;
          --text: #f3eee4;
          --muted: #b4aa99;
          --faint: #8a8071;
          --accent: #db8a6a;
          --accent-soft: #3a2c23;
          --accent-ink: #1b1410;
          --ok: #82b277;
          --warn: #d6a45c;
          --shadow: 0 1px 2px rgba(0, 0, 0, 0.3), 0 12px 32px -16px rgba(0, 0, 0, 0.6);
        }
      }
      * { box-sizing: border-box; }
      html { -webkit-text-size-adjust: 100%; }
      body {
        margin: 0;
        min-height: 100vh;
        padding: clamp(20px, 5vw, 56px) 20px 48px;
        font-family: var(--sans);
        color: var(--text);
        background:
          radial-gradient(1200px 600px at 50% -10%, var(--bg-glow), transparent 70%),
          var(--bg);
        line-height: 1.5;
        -webkit-font-smoothing: antialiased;
        text-rendering: optimizeLegibility;
      }
      .shell { width: min(100%, 640px); margin: 0 auto; }

      .masthead {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        margin-bottom: 26px;
      }
      .brand { display: flex; align-items: center; gap: 14px; }
      .mark {
        width: 44px; height: 44px;
        border-radius: 13px;
        display: grid; place-items: center;
        font-family: var(--serif);
        font-size: 22px; font-weight: 600;
        color: var(--accent-ink);
        background: linear-gradient(150deg, #cf6a45, #b5512f);
        box-shadow: 0 6px 16px -8px rgba(177, 81, 47, 0.7), inset 0 1px 0 rgba(255,255,255,0.22);
        letter-spacing: 0.5px;
      }
      .brand h1 {
        margin: 0;
        font-family: var(--serif);
        font-size: 27px;
        font-weight: 600;
        letter-spacing: -0.01em;
        line-height: 1.05;
      }
      .tagline { margin: 3px 0 0; color: var(--muted); font-size: 13.5px; }

      .live {
        display: inline-flex; align-items: center; gap: 8px;
        padding: 7px 13px 7px 11px;
        border: 1px solid var(--border);
        border-radius: 999px;
        background: var(--surface);
        font-size: 12.5px; font-weight: 560;
        color: var(--muted);
        box-shadow: var(--shadow);
        white-space: nowrap;
      }
      .dot {
        width: 8px; height: 8px; border-radius: 999px;
        background: var(--faint);
        box-shadow: 0 0 0 0 transparent;
      }
      .dot.ok { background: var(--ok); animation: breathe 2.6s ease-in-out infinite; }
      .dot.warn { background: var(--warn); }
      @keyframes breathe {
        0%, 100% { box-shadow: 0 0 0 0 rgba(95, 140, 87, 0.35); }
        50% { box-shadow: 0 0 0 5px rgba(95, 140, 87, 0); }
      }
      @media (prefers-reduced-motion: reduce) { .dot.ok { animation: none; } }

      .cards { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
      @media (max-width: 460px) { .cards { grid-template-columns: 1fr; } }

      .card {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: var(--radius);
        box-shadow: var(--shadow);
        padding: 16px 18px;
      }
      .card + .card-block, .cards + .card-block { margin-top: 14px; }
      .card h2 {
        margin: 0 0 6px;
        font-size: 11.5px;
        font-weight: 600;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--faint);
      }
      .row {
        display: flex; align-items: center; justify-content: space-between;
        gap: 12px; min-height: 40px;
        border-top: 1px solid var(--border);
        font-size: 14.5px;
      }
      .row:first-of-type { border-top: 0; }
      .label { color: var(--muted); }
      .value {
        max-width: 62%; text-align: right; font-weight: 580;
        overflow-wrap: anywhere;
      }
      .value.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; color: var(--muted); }

      .conversation .bubble {
        margin-top: 12px;
        padding: 12px 14px;
        border-radius: 13px;
        background: var(--surface-soft);
        border: 1px solid var(--border);
      }
      .conversation .bubble.said {
        background: var(--accent-soft);
        border-color: transparent;
      }
      .bubble-label {
        display: block;
        font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase;
        color: var(--faint); margin-bottom: 4px;
      }
      .bubble.said .bubble-label { color: var(--accent); }
      .bubble p { margin: 0; font-size: 14.5px; color: var(--text); overflow-wrap: anywhere; }
      .conversation .row.event { margin-top: 12px; padding-top: 12px; }

      .chips { display: flex; flex-wrap: wrap; gap: 8px; margin: 4px 0 14px; }
      .chip {
        appearance: none; cursor: pointer;
        border: 1px solid var(--border-strong);
        background: var(--surface);
        color: var(--text);
        font: inherit; font-size: 13.5px; font-weight: 540;
        padding: 8px 14px; border-radius: 999px;
        transition: background 140ms ease, border-color 140ms ease, transform 140ms ease;
      }
      .chip:hover { background: var(--surface-soft); border-color: var(--faint); }
      .chip:active { transform: translateY(1px); }
      .chip.primary {
        background: var(--accent); border-color: var(--accent); color: var(--accent-ink);
        box-shadow: 0 6px 16px -10px rgba(177, 81, 47, 0.8);
      }
      .chip.primary:hover { background: #b5512f; border-color: #b5512f; }

      .composer { display: flex; gap: 9px; }
      .composer input {
        flex: 1; min-width: 0;
        border: 1px solid var(--border-strong);
        background: var(--surface-soft);
        color: var(--text); font: inherit; font-size: 14.5px;
        padding: 11px 14px; border-radius: var(--radius-sm);
        transition: border-color 140ms ease, box-shadow 140ms ease, background 140ms ease;
      }
      .composer input::placeholder { color: var(--faint); }
      .composer input:focus {
        outline: none; background: var(--surface);
        border-color: var(--accent);
        box-shadow: 0 0 0 3px var(--accent-soft);
      }
      .send {
        appearance: none; cursor: pointer;
        border: 1px solid var(--accent); background: var(--accent); color: var(--accent-ink);
        font: inherit; font-weight: 600; font-size: 14px;
        padding: 0 18px; border-radius: var(--radius-sm);
        transition: background 140ms ease, transform 140ms ease, opacity 140ms ease;
      }
      .send:hover { background: #b5512f; border-color: #b5512f; }
      .send:active { transform: translateY(1px); }
      .send:disabled, .chip:disabled { opacity: 0.5; cursor: default; transform: none; }
      .hint { margin: 12px 0 0; font-size: 12.5px; color: var(--faint); min-height: 1px; }

      .foot {
        margin-top: 22px;
        display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
        font-size: 12px; color: var(--faint);
      }
      .foot .sep { opacity: 0.5; }
    </style>
  </head>
  <body>
    <main class="shell">
      <header class="masthead">
        <div class="brand">
          <div class="mark" aria-hidden="true">C</div>
          <div class="brand-text">
            <h1>Cally</h1>
            <p class="tagline">Voice copilot for Mentra glasses</p>
          </div>
        </div>
        <div class="live" title="Service status">
          <span id="status-dot" class="dot"></span>
          <span id="status-text">Checking</span>
        </div>
      </header>

      <section class="cards">
        <article class="card">
          <h2>Overview</h2>
          <div class="row"><span class="label">Active sessions</span><span id="sessions" class="value">—</span></div>
          <div class="row"><span class="label">Mode</span><span id="mode" class="value">—</span></div>
          <div class="row"><span class="label">Connection</span><span id="connection" class="value">—</span></div>
        </article>
        <article class="card">
          <h2>Device</h2>
          <div class="row"><span class="label">Wi-Fi</span><span id="wifi" class="value">—</span></div>
          <div class="row"><span class="label">Battery</span><span id="battery" class="value">—</span></div>
          <div class="row"><span class="label">Package</span><span class="value mono">${PACKAGE_NAME}</span></div>
        </article>
      </section>

      <section class="card conversation card-block">
        <h2>Recent</h2>
        <div class="bubble heard"><span class="bubble-label">You said</span><p id="last-heard">—</p></div>
        <div class="bubble said"><span class="bubble-label">Cally said</span><p id="last-reply">—</p></div>
        <div class="row event"><span class="label">Last event</span><span id="last-event" class="value">—</span></div>
      </section>

      <section class="card console card-block">
        <h2>Ask Cally</h2>
        <div class="chips">
          <button class="chip" data-command="help">Help</button>
          <button class="chip" data-command="status">Status</button>
          <button class="chip primary" data-command="look around">Look around</button>
          <button class="chip" data-command="recap">Recap</button>
        </div>
        <div class="composer">
          <input id="command-input" placeholder="Type a message for Cally…" autocomplete="off" autocapitalize="sentences" />
          <button id="send-command" class="send">Send</button>
        </div>
        <p id="console-hint" class="hint"></p>
      </section>

      <footer class="foot">
        <span class="mono" style="font-family:ui-monospace,Menlo,monospace">${PACKAGE_NAME}</span>
        <span class="sep">·</span>
        <span>voice engine ${voiceEngine}</span>
      </footer>
    </main>
    <script>
      const params = new URLSearchParams(location.hash.replace(/^#/, ""));
      const token = params.get("token") || "";
      let sessionId = "";

      function setText(id, value) {
        const el = document.getElementById(id);
        if (el) el.textContent = value;
      }

      async function api(path, options) {
        options = options || {};
        const headers = Object.assign({}, options.headers || {});
        const url = new URL(path, location.origin);
        if (token) headers.authorization = "Bearer " + token;
        return fetch(url.pathname + url.search, Object.assign({}, options, { headers: headers, cache: "no-store" }));
      }

      function setControlsEnabled(enabled) {
        const send = document.getElementById("send-command");
        const input = document.getElementById("command-input");
        if (send) send.disabled = !enabled;
        if (input) input.disabled = !enabled;
        document.querySelectorAll("[data-command]").forEach(function (b) { b.disabled = !enabled; });
      }

      function updateHint() {
        const hint = document.getElementById("console-hint");
        if (!hint) return;
        if (!token) { hint.textContent = "Read-only view. Append #token=YOUR_TOKEN to send commands."; return; }
        if (!sessionId) { hint.textContent = "Waiting for an active glasses session…"; return; }
        hint.textContent = "";
      }

      async function refreshStatus() {
        const dot = document.getElementById("status-dot");
        try {
          const response = await fetch("/health", { cache: "no-store" });
          if (!response.ok) throw new Error(String(response.status));
          const data = await response.json();
          if (dot) dot.className = "dot ok";
          setText("status-text", "Online");
          const count = data.sessions != null ? data.sessions : (data.activeSessions != null ? data.activeSessions : 0);
          setText("sessions", String(count));

          if (!token) { setControlsEnabled(false); updateHint(); return; }
          const detailed = await api("/status");
          if (!detailed.ok) { updateHint(); return; }
          const detail = await detailed.json();
          const list = detail.sessions || [];
          const first = list[0];
          sessionId = (first && first.sessionId) || "";
          const device = (first && first.device) || {};

          setText("mode", (first && first.mode) || "—");
          setText("connection", device.glassesConnected ? "Connected" : (first ? "Linked" : "—"));
          setText("wifi", device.wifiConnected ? (device.wifiSsid || "Connected") : "—");
          setText("battery", device.batteryLevel == null ? "—" : device.batteryLevel + "%");
          setText("last-heard", (first && first.lastTranscript) || "—");
          setText("last-reply", (first && first.lastReply) || "—");
          setText("last-event", (first && first.lastEvent) || "—");

          setControlsEnabled(Boolean(sessionId));
          updateHint();
        } catch (err) {
          if (dot) dot.className = "dot warn";
          setText("status-text", "Offline");
          setText("sessions", "—");
        }
      }

      async function sendCommand(text) {
        if (!token || !sessionId || !text) return;
        const send = document.getElementById("send-command");
        if (send) { send.disabled = true; send.textContent = "Sending…"; }
        try {
          await api("/sessions/" + encodeURIComponent(sessionId) + "/command", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text: text }),
          });
          await refreshStatus();
        } finally {
          if (send) { send.textContent = "Send"; send.disabled = !sessionId; }
        }
      }

      document.querySelectorAll("[data-command]").forEach(function (button) {
        button.addEventListener("click", function () { sendCommand(button.dataset.command); });
      });
      const input = document.getElementById("command-input");
      function submitInput() {
        const value = input.value.trim();
        if (!value) return;
        sendCommand(value);
        input.value = "";
      }
      document.getElementById("send-command").addEventListener("click", submitInput);
      input.addEventListener("keydown", function (e) { if (e.key === "Enter") submitInput(); });

      setControlsEnabled(false);
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

    this.subscribeTranscription(record, sessionId);

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

  /**
   * Preserves AppServer.start() (including SDK startup checks) while capturing
   * the HTTP server that its private implementation otherwise discards.
   */
  public startWithDirectGlasses(directGlasses: DirectGlassesGateway): Promise<void> {
    const app = this.getExpressApp();
    const originalListenProperty = app.listen;
    const originalListen = app.listen.bind(app) as (port: number, callback?: () => void) => HttpServer;
    let httpServer: HttpServer | undefined;

    app.listen = ((port: number, callback?: () => void) => {
      const startedServer = originalListen(port, callback);
      try {
        directGlasses.attach(startedServer);
      } catch (error) {
        startedServer.close();
        throw error;
      }
      httpServer = startedServer;
      this.addCleanupHandler(() => {
        directGlasses.close();
        try {
          startedServer.close();
        } catch {
          // Cleanup can run after a failed or already-complete close.
        }
      });
      return startedServer;
    }) as typeof app.listen;

    try {
      const started = super.start();
      if (!httpServer) {
        return Promise.reject(new Error("Mentra AppServer did not create an HTTP listener"));
      }
      return started;
    } finally {
      app.listen = originalListenProperty;
    }
  }

  public wireControlEndpoints(directGlasses: DirectGlassesGateway): void {
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

    app.get("/assets/cally-ack.mp3", (_req: Request, res: Response) => {
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

    // Unlike legacy local controls, the direct-device surface fails closed if
    // no control token is configured.
    registerDirectGlassesHttpRoutes(
      app,
      directGlasses,
      createDirectGlassesBearerAuthorizer(CONTROL_TOKEN),
    );

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

  private subscribeTranscription(record: SessionRecord, sessionId: string): void {
    const handler = (data: TranscriptionData) => {
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
    } catch (error) {
      record.session.logger.warn({ error: this.shortError(error), lang }, "Language transcription unavailable; using en-US");
    }
    record.cleanup.push(record.session.events.onTranscription(handler));
  }

  private async handleTranscription(sessionId: string, data: TranscriptionData): Promise<void> {
    if (!data.isFinal) return;

    const record = this.sessions.get(sessionId);
    if (!record) return;

    const text = data.text.trim();
    if (!text) return;

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
  private acknowledgeWake(record: SessionRecord): void {
    this.showText(record, "Cally listening…", 2500);
    if (CALLY_ACK_SOUND) void this.playAckChime(record);
  }

  private async playAckChime(record: SessionRecord): Promise<void> {
    if (!CALLY_ACK_SOUND_URL) return;
    try {
      if (record.session.capabilities && record.session.capabilities.hasSpeaker === false) return;
      // Same path/params as the (working) TTS reply so the device actually plays
      // it: MP3 over the public URL, default track, stops nothing else of note
      // since no other audio is playing the moment the wake word lands.
      await record.session.audio.playAudio({
        audioUrl: CALLY_ACK_SOUND_URL,
        volume: CALLY_ACK_VOLUME,
      });
    } catch (error) {
      record.session.logger.warn({ error: this.shortError(error) }, "Wake-word chime failed");
    }
  }

  private wakeOptions: WakeOptions = {
    extraVariants: parseExtraVariants(CALLY_WAKE_WORDS),
    fuzzy: CALLY_WAKE_FUZZY,
  };

  private extractWakeCommand(text: string): string | null {
    return matchWakeCommand(text, this.wakeOptions);
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

    // Primary low-latency path: direct OpenAI with the compressed brain digest.
    if (CALLY_OPENAI_ENABLED && input.kind !== "photo") {
      const fast = await this.askViaOpenAi(record, input);
      if (fast) return fast;
    }

    if (CALLY_AGENT_CLI_ENABLED) {
      return this.askViaCli(record, input);
    }

    return this.localReply(record, input);
  }

  private openAiConfig: OpenAiBridgeConfig = {
    apiKey: CALLY_OPENAI_API_KEY,
    model: CALLY_OPENAI_MODEL,
    digestPath: CALLY_OPENAI_DIGEST_PATH,
    maxTokens: CALLY_OPENAI_MAX_TOKENS,
    timeoutMs: CALLY_OPENAI_TIMEOUT_MS,
    baseUrl: CALLY_OPENAI_BASE_URL,
  };

  private async askViaOpenAi(
    record: SessionRecord,
    input: { kind: "voice" | "photo" | "control"; text: string },
  ): Promise<string | null> {
    const result = await callOpenAi(this.openAiConfig, {
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
    const options = this.softTtsOptions();
    try {
      if (record.session.capabilities && record.session.capabilities.hasSpeaker === false) return;
      await record.session.audio.speak(text, options);
    } catch (error) {
      record.session.logger.warn({ error }, "Soft TTS failed; retrying platform default");
      try {
        await record.session.audio.speak(text);
      } catch (retryError) {
        record.session.logger.warn({ error: retryError }, "TTS failed");
      }
    }
  }

  private softTtsOptions() {
    const options: {
      voice_id?: string;
      model_id?: string;
      voice_settings: {
        stability: number;
        similarity_boost: number;
        style: number;
        use_speaker_boost: boolean;
        speed: number;
      };
      volume: number;
      trackId: number;
    } = {
      voice_settings: {
        stability: CALLY_TTS_STABILITY,
        similarity_boost: CALLY_TTS_SIMILARITY,
        style: CALLY_TTS_STYLE,
        use_speaker_boost: CALLY_TTS_SPEAKER_BOOST,
        speed: CALLY_TTS_SPEED,
      },
      volume: CALLY_TTS_VOLUME,
      trackId: 2,
    };
    if (CALLY_TTS_VOICE_ID) options.voice_id = CALLY_TTS_VOICE_ID;
    if (CALLY_TTS_MODEL_ID) options.model_id = CALLY_TTS_MODEL_ID;
    return options;
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

  private formatDateTime(): string {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: process.env.CALLY_TIMEZONE || "America/Los_Angeles",
      weekday: "long",
      hour: "numeric",
      minute: "2-digit",
      month: "long",
      day: "numeric",
    }).format(new Date());
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

  private authorized(req: Request): boolean {
    return controlAuthorized(req);
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

const appServer = new CallyMentraApp({
  packageName: PACKAGE_NAME,
  apiKey: MENTRAOS_API_KEY,
  port: PORT,
  ...(CALLY_COOKIE_SECRET ? { cookieSecret: CALLY_COOKIE_SECRET } : {}),
});
const directGlassesConfig = directGlassesConfigFromEnv(process.env);
const cloudflareAccessConfig = cloudflareAccessConfigFromEnv(process.env);
let directGlassesAuthMode = directGlassesConfig.deviceToken
  ? "development shared token"
  : "disabled";

if (cloudflareAccessConfig) {
  directGlassesConfig.upgradeAuthenticator =
    createCloudflareAccessUpgradeAuthenticator(cloudflareAccessConfig);
  // An injected authenticator takes precedence already, but removing this value
  // makes it explicit that production never falls back when Access rejects.
  delete directGlassesConfig.deviceToken;
  directGlassesAuthMode = "Cloudflare Access";
} else if (process.env.NODE_ENV === "production" && directGlassesConfig.deviceToken) {
  console.error(
    "CALLY_GLASSES_DEVICE_TOKEN is development-only; configure Cloudflare Access for production.",
  );
  process.exit(1);
}

const directGlasses = new DirectGlassesGateway(directGlassesConfig, appServer.logger);

appServer.wireControlEndpoints(directGlasses);

appServer.startWithDirectGlasses(directGlasses)
  .then(() => {
    console.log(`Cally Mentra app listening on port ${PORT}`);
    console.log(
      `Direct glasses WSS: ${directGlasses.enabled ? `enabled (${directGlassesAuthMode})` : "disabled"}`,
    );
    const bridge = CALLY_AGENT_WEBHOOK_URL
      ? "webhook"
      : CALLY_AGENT_CLI_ENABLED
        ? `local CLI (${CALLY_AGENT_CLI_PATH})`
        : "local fallback only";
    console.log(`Cally agent bridge: ${bridge}`);
  })
  .catch((error) => {
    directGlasses.close();
    console.error("Cally Mentra app failed to start:", error);
    process.exit(1);
  });
