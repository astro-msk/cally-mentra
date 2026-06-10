import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export type MealType = "breakfast" | "lunch" | "dinner" | "snack" | "unknown";
export type NutritionConfidence = "explicit" | "estimated" | "unknown";

export type LoseFitEntry = {
  id: string;
  createdAt: string;
  eatenAt: string;
  source: "mentra" | "control" | "tool" | "cli";
  rawText: string;
  mealType: MealType;
  items: string[];
  nutrition: {
    calories: number | null;
    proteinG: number | null;
    carbsG: number | null;
    fatG: number | null;
    confidence: NutritionConfidence;
    method: string;
  };
  status: "needs_review" | "logged";
  loseIt: {
    imported: boolean;
    importedAt: string | null;
    externalId: string | null;
  };
};

export type LoseFitSummary = {
  date: string;
  entries: LoseFitEntry[];
  totalCalories: number | null;
  reviewedCalories: number;
  estimatedCalories: number;
};

const explicitCaloriesSchema = z.object({ calories: z.number().int().min(0).max(10000) });

const COMMON_ESTIMATES: Array<{ pattern: RegExp; calories: number; proteinG?: number; carbsG?: number; fatG?: number }> = [
  { pattern: /chicken\s+(rice\s+)?bowl|chicken.*bowl/i, calories: 650, proteinG: 42, carbsG: 62, fatG: 22 },
  { pattern: /salad/i, calories: 450, proteinG: 25, carbsG: 28, fatG: 24 },
  { pattern: /burrito/i, calories: 850, proteinG: 38, carbsG: 95, fatG: 32 },
  { pattern: /chipotle.*bowl|bowl.*chipotle/i, calories: 750, proteinG: 42, carbsG: 78, fatG: 28 },
  { pattern: /pizza/i, calories: 700, proteinG: 28, carbsG: 78, fatG: 30 },
  { pattern: /burger/i, calories: 650, proteinG: 32, carbsG: 45, fatG: 36 },
  { pattern: /fries/i, calories: 420, proteinG: 5, carbsG: 54, fatG: 20 },
  { pattern: /dumpling/i, calories: 520, proteinG: 22, carbsG: 62, fatG: 20 },
  { pattern: /noodle|ramen|pho/i, calories: 720, proteinG: 30, carbsG: 92, fatG: 24 },
  { pattern: /biryani/i, calories: 850, proteinG: 35, carbsG: 95, fatG: 32 },
  { pattern: /sandwich/i, calories: 560, proteinG: 28, carbsG: 58, fatG: 22 },
  { pattern: /protein\s+bar/i, calories: 220, proteinG: 20, carbsG: 22, fatG: 7 },
  { pattern: /water|diet\s+soda|black\s+coffee|unsweetened\s+tea/i, calories: 0, proteinG: 0, carbsG: 0, fatG: 0 },
  { pattern: /tea|coffee/i, calories: 50, proteinG: 0, carbsG: 12, fatG: 0 },
  { pattern: /soda|coke|pepsi|sprite/i, calories: 150, proteinG: 0, carbsG: 39, fatG: 0 },
];

export function defaultLoseFitLogPath(): string {
  return path.resolve(process.cwd(), process.env.LOSEFIT_LOG_PATH || "../../data/losefit/meal-log.jsonl");
}

export class LoseFitStore {
  constructor(private readonly logPath = defaultLoseFitLogPath()) {}

  get path(): string {
    return this.logPath;
  }

  async log(rawText: string, source: LoseFitEntry["source"] = "tool", now = new Date()): Promise<LoseFitEntry> {
    const entry = createEntry(rawText, source, now);
    await fs.mkdir(path.dirname(this.logPath), { recursive: true });
    await fs.appendFile(this.logPath, `${JSON.stringify(entry)}\n`, "utf8");
    return entry;
  }

  async list(): Promise<LoseFitEntry[]> {
    try {
      const raw = await fs.readFile(this.logPath, "utf8");
      return raw
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as LoseFitEntry)
        .filter(isLoseFitEntry)
        .sort((a, b) => a.eatenAt.localeCompare(b.eatenAt));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async summaryForLocalDate(date = localDate(new Date())): Promise<LoseFitSummary> {
    const entries = (await this.list()).filter((entry) => localDate(new Date(entry.eatenAt)) === date);
    const known = entries.filter((entry) => entry.nutrition.calories != null);
    return {
      date,
      entries,
      totalCalories: known.length === entries.length ? sumCalories(entries) : known.length ? sumCalories(known) : null,
      reviewedCalories: sumCalories(entries.filter((entry) => entry.nutrition.confidence === "explicit")),
      estimatedCalories: sumCalories(entries.filter((entry) => entry.nutrition.confidence === "estimated")),
    };
  }

  async exportCsv(csvPath = this.logPath.replace(/\.jsonl$/i, ".csv")): Promise<string> {
    const entries = await this.list();
    await fs.mkdir(path.dirname(csvPath), { recursive: true });
    const rows = [
      ["Date", "Meal", "Food", "Calories", "Protein (g)", "Carbs (g)", "Fat (g)", "Source", "Status", "Notes"],
      ...entries.map((entry) => [
        localDate(new Date(entry.eatenAt)),
        entry.mealType,
        entry.items.join("; "),
        value(entry.nutrition.calories),
        value(entry.nutrition.proteinG),
        value(entry.nutrition.carbsG),
        value(entry.nutrition.fatG),
        entry.source,
        entry.status,
        `LoseFit id=${entry.id}; confidence=${entry.nutrition.confidence}; raw=${entry.rawText}`,
      ]),
    ];
    await fs.writeFile(csvPath, rows.map((row) => row.map(csvEscape).join(",")).join("\n") + "\n", "utf8");
    return csvPath;
  }
}

export function isLoseFitLogCommand(text: string): boolean {
  return /\b(log|track|record|save)\b.*\b(meal|food|calories|breakfast|lunch|dinner|snack)\b/i.test(text)
    || /\b(i\s+(ate|had)|for\s+(breakfast|lunch|dinner|snack))\b/i.test(text)
    || /\blose\s*(it|fit)\b/i.test(text);
}

export function isLoseFitSummaryCommand(text: string): boolean {
  return /\b(lose\s*(it|fit)|calories|food|meal).*(today|summary|recap|list|what did i eat)\b/i.test(text)
    || /\b(what did i eat|calories today|food today|meal summary)\b/i.test(text);
}

export function createEntry(rawText: string, source: LoseFitEntry["source"], now = new Date()): LoseFitEntry {
  const normalized = stripCommand(rawText);
  const explicit = extractExplicitCalories(rawText);
  const items = extractItems(normalized);
  const estimate = explicit ?? estimateNutrition(items.length ? items : [normalized]);

  return {
    id: `lf_${now.toISOString().replace(/[-:.TZ]/g, "")}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: now.toISOString(),
    eatenAt: now.toISOString(),
    source,
    rawText,
    mealType: detectMealType(rawText, now),
    items: items.length ? items : [normalized || rawText.trim()],
    nutrition: estimate,
    status: "needs_review",
    loseIt: {
      imported: false,
      importedAt: null,
      externalId: null,
    },
  };
}

export function formatLoggedEntry(entry: LoseFitEntry): string {
  const calories = entry.nutrition.calories == null ? "calories unknown" : `${entry.nutrition.calories} cal ${entry.nutrition.confidence === "explicit" ? "logged" : "estimated"}`;
  return `Logged ${entry.mealType}: ${entry.items.join(", ")} (${calories}). I marked it needs review before Lose It import.`;
}

export function formatSummary(summary: LoseFitSummary): string {
  if (!summary.entries.length) return `No LoseFit meals logged for ${summary.date} yet.`;
  const total = summary.totalCalories == null ? "partial calories unknown" : `${summary.totalCalories} cal total`;
  const meals = summary.entries.map((entry) => `${entry.mealType}: ${entry.items.join(", ")} (${entry.nutrition.calories ?? "?"} cal)`).join(" / ");
  return `${summary.date}: ${total}. ${meals}`;
}

function stripCommand(text: string): string {
  return text
    .replace(/^\s*(cally|kali|callie)[,:]?\s*/i, "")
    .replace(/^\s*(lose\s*(it|fit)\s*)?(log|track|record|save)\s+(my\s+)?(meal|food|breakfast|lunch|dinner|snack|calories)?\s*/i, "")
    .replace(/^\s*i\s+(ate|had)\s+/i, "")
    .replace(/\s+(to|in)\s+lose\s*(it|fit)\s*$/i, "")
    .trim();
}

function extractExplicitCalories(text: string): LoseFitEntry["nutrition"] | null {
  const match = text.match(/(?:^|\D)(\d{2,5})\s*(?:k?cal|calories?)(?:\D|$)/i);
  if (!match) return null;
  const parsed = explicitCaloriesSchema.safeParse({ calories: Number(match[1]) });
  if (!parsed.success) return null;
  return {
    calories: parsed.data.calories,
    proteinG: extractMacro(text, /protein/i),
    carbsG: extractMacro(text, /carbs?|carbohydrates?/i),
    fatG: extractMacro(text, /fat/i),
    confidence: "explicit",
    method: "user_provided_calories",
  };
}

function extractMacro(text: string, label: RegExp): number | null {
  const gramsBefore = new RegExp(`(\\d{1,3})\\s*g(?:rams?)?\\s+${label.source}`, "i").exec(text);
  const gramsAfter = new RegExp(`${label.source}\\s*[:=]?\\s*(\\d{1,3})\\s*g?`, "i").exec(text);
  const value = Number(gramsBefore?.[1] ?? gramsAfter?.[1] ?? NaN);
  return Number.isFinite(value) ? value : null;
}

function estimateNutrition(items: string[]): LoseFitEntry["nutrition"] {
  const matches = items
    .map((item) => COMMON_ESTIMATES.find((estimate) => estimate.pattern.test(item)))
    .filter((estimate): estimate is (typeof COMMON_ESTIMATES)[number] => Boolean(estimate));
  if (!matches.length) {
    return { calories: null, proteinG: null, carbsG: null, fatG: null, confidence: "unknown", method: "no_estimate_available" };
  }

  return {
    calories: matches.reduce((total, item) => total + item.calories, 0),
    proteinG: optionalSum(matches.map((item) => item.proteinG)),
    carbsG: optionalSum(matches.map((item) => item.carbsG)),
    fatG: optionalSum(matches.map((item) => item.fatG)),
    confidence: "estimated",
    method: "keyword_estimate_v1",
  };
}

function extractItems(text: string): string[] {
  return text
    .replace(/\bfor\s+(breakfast|lunch|dinner|snack)\b/gi, "")
    .replace(/\bwith\b/gi, ",")
    .replace(/\band\b/gi, ",")
    .split(/[,;]+/)
    .map((item) => item
      .trim()
      .replace(/^a\s+/i, "")
      .replace(/^(breakfast|lunch|dinner|snack)\s+/i, "")
      .replace(/\b\d{2,5}\s*(k?cal|calories?)\b/gi, "")
      .replace(/\b(protein|carbs?|carbohydrates?|fat)\s*[:=]?\s*\d{1,3}\s*g?\b/gi, "")
      .replace(/\b\d{1,3}\s*g(?:rams?)?\s+(protein|carbs?|carbohydrates?|fat)\b/gi, "")
      .replace(/\s{2,}/g, " ")
      .trim())
    .filter((item) => item.length > 1 && !/^\d+\s*(k?cal|calories?)$/i.test(item))
    .slice(0, 12);
}

function detectMealType(text: string, now: Date): MealType {
  const lower = text.toLowerCase();
  if (/breakfast/.test(lower)) return "breakfast";
  if (/lunch/.test(lower)) return "lunch";
  if (/dinner/.test(lower)) return "dinner";
  if (/snack/.test(lower)) return "snack";

  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", hour12: false }).format(now));
  if (hour >= 5 && hour < 11) return "breakfast";
  if (hour >= 11 && hour < 16) return "lunch";
  if (hour >= 16 && hour < 22) return "dinner";
  return "snack";
}

function localDate(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function optionalSum(values: Array<number | undefined>): number | null {
  const known = values.filter((item): item is number => typeof item === "number");
  return known.length ? known.reduce((total, item) => total + item, 0) : null;
}

function sumCalories(entries: LoseFitEntry[]): number {
  return entries.reduce((total, entry) => total + (entry.nutrition.calories ?? 0), 0);
}

function value(input: number | null): string {
  return input == null ? "" : String(input);
}

function csvEscape(input: string): string {
  if (!/[",\n]/.test(input)) return input;
  return `"${input.replace(/"/g, '""')}"`;
}

function isLoseFitEntry(input: unknown): input is LoseFitEntry {
  if (!input || typeof input !== "object") return false;
  const entry = input as Partial<LoseFitEntry>;
  return typeof entry.id === "string" && Array.isArray(entry.items) && typeof entry.createdAt === "string";
}
