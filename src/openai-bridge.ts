import { readFile, stat } from "node:fs/promises";

// Direct, low-latency bridge to the OpenAI Chat Completions API.
//
// The full OpenClaw agent turn is ~13-20s on this 2-vCPU box — almost entirely
// per-turn machinery (CLI spawn, gateway context assembly, plugin/skill load),
// NOT the model: the raw API answers in ~0.6s. For the glasses voice path we
// therefore call OpenAI directly from the always-warm app process and feed it a
// compressed digest of Cally's "brain" as the system prompt. That is the
// latency/brain tradeoff: a fraction of the 150k context, a fraction of the
// latency. Complex requests can still fall back to the full agent.

export type OpenAiBridgeConfig = {
  apiKey: string;
  model: string;
  digestPath: string;
  maxTokens: number;
  timeoutMs: number;
  baseUrl: string;
};

export type OpenAiTurnInput = {
  text: string;
  recentTranscripts?: string[];
  notes?: string[];
};

export type OpenAiResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

let digestCache: { mtimeMs: number; text: string } | null = null;

/** Reads the compressed digest, re-reading only when the file changes on disk. */
async function loadDigest(digestPath: string): Promise<string> {
  if (!digestPath) return "";
  try {
    const info = await stat(digestPath);
    if (digestCache && digestCache.mtimeMs === info.mtimeMs) return digestCache.text;
    const text = (await readFile(digestPath, "utf8")).trim();
    digestCache = { mtimeMs: info.mtimeMs, text };
    return text;
  } catch {
    return "";
  }
}

const FALLBACK_PERSONA =
  "You are Cally, a warm, concise voice assistant speaking through smart glasses.";

const VOICE_RULES =
  "Answer in one or two short spoken sentences. Lead with the answer. No markdown, no lists, no preamble.";

export async function callOpenAi(cfg: OpenAiBridgeConfig, input: OpenAiTurnInput): Promise<OpenAiResult> {
  const digest = await loadDigest(cfg.digestPath);
  const system = `${digest || FALLBACK_PERSONA}\n\n${VOICE_RULES}`;

  const userParts = [input.text.trim()];
  const recent = (input.recentTranscripts || []).filter((line) => line && line !== input.text).slice(-3);
  if (recent.length) userParts.push(`(Recent things I said: ${recent.join(" | ")})`);
  if (input.notes?.length) userParts.push(`(My saved notes: ${input.notes.slice(-5).join(" | ")})`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const response = await fetch(`${cfg.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: userParts.join("\n") },
        ],
        max_completion_tokens: cfg.maxTokens,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return { ok: false, error: truncate(`openai ${response.status}: ${body}`, 220) };
    }

    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = json.choices?.[0]?.message?.content?.trim();
    if (!text) return { ok: false, error: "openai returned no text" };
    return { ok: true, text };
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    return { ok: false, error: aborted ? "openai timeout" : truncate(String(error), 220) };
  } finally {
    clearTimeout(timer);
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
