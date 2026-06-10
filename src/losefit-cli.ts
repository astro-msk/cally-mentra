#!/usr/bin/env node
import fs from "node:fs/promises";
import { LoseFitStore, formatLoggedEntry, formatSummary } from "./losefit";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const pathIndex = args.indexOf("--path");
  const customPath = pathIndex >= 0 ? args[pathIndex + 1] : undefined;
  if (pathIndex >= 0) args.splice(pathIndex, 2);

  const store = new LoseFitStore(customPath);
  const command = args.shift() || "help";

  if (command === "log") {
    const text = args.join(" ").trim();
    if (!text) throw new Error("Usage: losefit log <meal text>");
    const entry = await store.log(text, "cli");
    console.log(formatLoggedEntry(entry));
    return;
  }

  if (command === "today" || command === "summary") {
    console.log(formatSummary(await store.summaryForLocalDate()));
    return;
  }

  if (command === "export") {
    const csvPath = await store.exportCsv(args[0]);
    console.log(csvPath);
    return;
  }

  if (command === "smoke") {
    if (customPath) {
      await fs.rm(customPath, { force: true });
      await fs.rm(customPath.replace(/\.jsonl$/i, ".csv"), { force: true });
    }
    await store.log("lunch chicken bowl with unsweetened tea", "cli", new Date("2026-06-08T19:00:00.000Z"));
    const summary = await store.summaryForLocalDate("2026-06-08");
    const csvPath = await store.exportCsv();
    console.log(formatSummary(summary));
    console.log(`csv=${csvPath}`);
    return;
  }

  console.log(`LoseFit commands:\n  log <meal text>\n  today\n  export [path]\n  smoke [--path tmp.jsonl]`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
