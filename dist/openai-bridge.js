"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.callOpenAi = callOpenAi;
const promises_1 = require("node:fs/promises");
let digestCache = null;
/** Reads the compressed digest, re-reading only when the file changes on disk. */
async function loadDigest(digestPath) {
    if (!digestPath)
        return "";
    try {
        const info = await (0, promises_1.stat)(digestPath);
        if (digestCache && digestCache.mtimeMs === info.mtimeMs)
            return digestCache.text;
        const text = (await (0, promises_1.readFile)(digestPath, "utf8")).trim();
        digestCache = { mtimeMs: info.mtimeMs, text };
        return text;
    }
    catch {
        return "";
    }
}
const FALLBACK_PERSONA = "You are Cally, a warm, concise voice assistant speaking through smart glasses.";
const VOICE_RULES = "Answer in one or two short spoken sentences. Lead with the answer. No markdown, no lists, no preamble.";
async function callOpenAi(cfg, input) {
    const digest = await loadDigest(cfg.digestPath);
    const system = `${digest || FALLBACK_PERSONA}\n\n${VOICE_RULES}`;
    const userParts = [input.text.trim()];
    const recent = (input.recentTranscripts || []).filter((line) => line && line !== input.text).slice(-3);
    if (recent.length)
        userParts.push(`(Recent things I said: ${recent.join(" | ")})`);
    if (input.notes?.length)
        userParts.push(`(My saved notes: ${input.notes.slice(-5).join(" | ")})`);
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
        const json = (await response.json());
        const text = json.choices?.[0]?.message?.content?.trim();
        if (!text)
            return { ok: false, error: "openai returned no text" };
        return { ok: true, text };
    }
    catch (error) {
        const aborted = error instanceof Error && error.name === "AbortError";
        return { ok: false, error: aborted ? "openai timeout" : truncate(String(error), 220) };
    }
    finally {
        clearTimeout(timer);
    }
}
function truncate(value, max) {
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
