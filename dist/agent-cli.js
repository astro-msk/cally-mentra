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
exports.callAgentCli = callAgentCli;
const node_child_process_1 = require("node:child_process");
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
/**
 * Builds a PATH for the child that includes common user-local npm bin
 * directories. systemd services launch with a minimal PATH (typically just
 * /usr/bin:/bin), which does not contain `~/.npm-global/bin` where a
 * user-installed `openclaw` lives — without this, `execFile("openclaw")` fails
 * with ENOENT even though the CLI is on the operator's interactive PATH.
 */
function childPath() {
    const home = os.homedir();
    const extra = [
        path.join(home, ".npm-global", "bin"),
        path.join(home, ".local", "bin"),
        "/usr/local/bin",
    ];
    const existing = process.env.PATH ? process.env.PATH.split(path.delimiter) : [];
    const seen = new Set();
    return [...extra, ...existing].filter((dir) => dir && !seen.has(dir) && seen.add(dir)).join(path.delimiter);
}
/**
 * Calls the local OpenClaw CLI to run a single Cally agent turn.
 *
 * Uses execFile (no shell) so the message and session key are passed as argv
 * entries and are never interpolated into a shell command — that keeps
 * arbitrary transcribed speech from being able to inject shell syntax.
 */
async function callAgentCli(opts) {
    const args = [
        "agent",
        "--session-key",
        opts.sessionKey,
        "--message",
        opts.message,
        "--json",
        "--timeout",
        String(opts.timeoutSeconds),
    ];
    if (opts.thinking)
        args.push("--thinking", opts.thinking);
    if (opts.model)
        args.push("--model", opts.model);
    return new Promise((resolve) => {
        (0, node_child_process_1.execFile)(opts.cliPath, args, {
            // Give the process a little headroom beyond the agent's own timeout so
            // we surface the agent's structured error rather than a hard kill.
            timeout: (opts.timeoutSeconds + 15) * 1000,
            maxBuffer: 16 * 1024 * 1024,
            windowsHide: true,
            env: { ...process.env, PATH: childPath() },
        }, (error, stdout, stderr) => {
            if (error) {
                const detail = truncate((stderr || "").trim() || error.message, 300);
                resolve({ ok: false, error: detail });
                return;
            }
            try {
                const json = JSON.parse(stdout);
                const status = typeof json?.status === "string" ? json.status : "ok";
                if (status !== "ok") {
                    const summary = typeof json?.summary === "string" ? json.summary : "";
                    resolve({ ok: false, error: truncate(`agent status ${status} ${summary}`.trim(), 300) });
                    return;
                }
                const text = extractText(json);
                if (!text) {
                    resolve({ ok: false, error: "agent returned no text" });
                    return;
                }
                resolve({ ok: true, text });
            }
            catch (parseError) {
                resolve({
                    ok: false,
                    error: truncate(`could not parse agent output: ${String(parseError)}`, 300),
                });
            }
        });
    });
}
/**
 * Extracts the visible assistant text from the CLI JSON envelope. Supports both
 * `{ result: { payloads: [{ text }] } }` (current shape) and a top-level
 * `finalAssistantVisibleText` fallback for forward/backward compatibility.
 */
function extractText(json) {
    const root = json;
    const result = root?.result ?? root ?? {};
    const payloads = result.payloads;
    if (Array.isArray(payloads)) {
        const joined = payloads
            .map((entry) => (entry && typeof entry === "object" ? entry.text : undefined))
            .filter((value) => typeof value === "string" && value.trim().length > 0)
            .join(" ")
            .trim();
        if (joined)
            return joined;
    }
    const visible = result.finalAssistantVisibleText;
    if (typeof visible === "string" && visible.trim())
        return visible.trim();
    return "";
}
function truncate(value, max) {
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
