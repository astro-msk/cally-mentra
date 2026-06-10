import { execFile } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Builds a PATH for the child that includes common user-local npm bin
 * directories. systemd services launch with a minimal PATH (typically just
 * /usr/bin:/bin), which does not contain `~/.npm-global/bin` where a
 * user-installed `openclaw` lives — without this, `execFile("openclaw")` fails
 * with ENOENT even though the CLI is on the operator's interactive PATH.
 */
function childPath(): string {
  const home = os.homedir();
  const extra = [
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".local", "bin"),
    "/usr/local/bin",
  ];
  const existing = process.env.PATH ? process.env.PATH.split(path.delimiter) : [];
  const seen = new Set<string>();
  return [...extra, ...existing].filter((dir) => dir && !seen.has(dir) && seen.add(dir)).join(path.delimiter);
}

export type CliBridgeOptions = {
  cliPath: string;
  sessionKey: string;
  message: string;
  timeoutSeconds: number;
  /** Thinking level (off|minimal|low|medium|high|...); omitted if empty. */
  thinking?: string;
  /** Model override (provider/model or model id); omitted if empty. */
  model?: string;
};

export type CliBridgeResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

/**
 * Calls the local OpenClaw CLI to run a single Cally agent turn.
 *
 * Uses execFile (no shell) so the message and session key are passed as argv
 * entries and are never interpolated into a shell command — that keeps
 * arbitrary transcribed speech from being able to inject shell syntax.
 */
export async function callAgentCli(opts: CliBridgeOptions): Promise<CliBridgeResult> {
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
  if (opts.thinking) args.push("--thinking", opts.thinking);
  if (opts.model) args.push("--model", opts.model);

  return new Promise<CliBridgeResult>((resolve) => {
    execFile(
      opts.cliPath,
      args,
      {
        // Give the process a little headroom beyond the agent's own timeout so
        // we surface the agent's structured error rather than a hard kill.
        timeout: (opts.timeoutSeconds + 15) * 1000,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, PATH: childPath() },
      },
      (error, stdout, stderr) => {
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
        } catch (parseError) {
          resolve({
            ok: false,
            error: truncate(`could not parse agent output: ${String(parseError)}`, 300),
          });
        }
      },
    );
  });
}

/**
 * Extracts the visible assistant text from the CLI JSON envelope. Supports both
 * `{ result: { payloads: [{ text }] } }` (current shape) and a top-level
 * `finalAssistantVisibleText` fallback for forward/backward compatibility.
 */
function extractText(json: unknown): string {
  const root = json as Record<string, unknown> | null;
  const result = (root?.result as Record<string, unknown> | undefined) ?? root ?? {};

  const payloads = result.payloads;
  if (Array.isArray(payloads)) {
    const joined = payloads
      .map((entry) => (entry && typeof entry === "object" ? (entry as Record<string, unknown>).text : undefined))
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .join(" ")
      .trim();
    if (joined) return joined;
  }

  const visible = result.finalAssistantVisibleText;
  if (typeof visible === "string" && visible.trim()) return visible.trim();

  return "";
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
