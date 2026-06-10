#!/usr/bin/env node
// Compresses the main OpenClaw workspace "brain" (~150k of bootstrap context)
// into a compact digest (~8k) for the low-latency `cally-glasses` agent.
//
// Strategy: keep the concise persona/identity/user/memory-index files verbatim
// (they are already dense and high-value), then append a trimmed slice of the
// most recent daily memory. This trades the long tail of the 150k context for
// a large latency + memory win while retaining Cally's voice and key facts.
//
// Re-run whenever memory changes (cron or on a timer). Idempotent.

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const MAIN_WS = process.env.MAIN_WORKSPACE || path.join(os.homedir(), ".openclaw", "workspace");
const OUT_WS = process.env.GLASSES_WORKSPACE || path.join(os.homedir(), ".openclaw", "workspace-glasses");
const RECENT_MEMORY_BUDGET = parseInt(process.env.DIGEST_RECENT_CHARS || "2600", 10);
const TOTAL_BUDGET = parseInt(process.env.DIGEST_TOTAL_CHARS || "8000", 10);

async function readIfExists(file) {
  try {
    return (await readFile(file, "utf8")).trim();
  } catch {
    return "";
  }
}

async function latestDailyMemory() {
  const dir = path.join(MAIN_WS, "memory");
  let files = [];
  try {
    files = (await readdir(dir)).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort();
  } catch {
    return "";
  }
  const newest = files.at(-1);
  if (!newest) return "";
  const body = await readIfExists(path.join(dir, newest));
  // Keep the tail (most recent entries) within budget.
  const slice = body.length > RECENT_MEMORY_BUDGET ? body.slice(-RECENT_MEMORY_BUDGET) : body;
  return `# Recent memory (${newest}, trimmed)\n${slice}`;
}

const VOICE_HEADER = `# Cally — Glasses Voice Mode

You are Cally, answering through smart glasses by voice. Optimise for speech:
- Reply in ONE or TWO short sentences. No lists, no markdown, no preamble.
- Lead with the answer. Skip caveats unless safety-critical.
- If you don't know, say so in a few words.
- The wearer is on the move; be direct and warm.

The sections below are a COMPRESSED snapshot of your fuller self (identity,
values, the user, and key memory). Treat them as background, not script.
`;

async function main() {
  const parts = [VOICE_HEADER];
  for (const name of ["IDENTITY.md", "SOUL.md", "USER.md", "MEMORY.md"]) {
    const body = await readIfExists(path.join(MAIN_WS, name));
    if (body) parts.push(`# ${name.replace(/\.md$/, "")}\n${body}`);
  }
  const recent = await latestDailyMemory();
  if (recent) parts.push(recent);

  let digest = parts.join("\n\n---\n\n");
  if (digest.length > TOTAL_BUDGET) digest = `${digest.slice(0, TOTAL_BUDGET)}\n\n[digest truncated]`;

  await mkdir(OUT_WS, { recursive: true });
  await writeFile(path.join(OUT_WS, "AGENTS.md"), `${digest}\n`);

  console.log(`Wrote digest: ${path.join(OUT_WS, "AGENTS.md")} (${digest.length} chars, from ~150k context)`);
}

main().catch((error) => {
  console.error("make-glasses-digest failed:", error);
  process.exit(1);
});
