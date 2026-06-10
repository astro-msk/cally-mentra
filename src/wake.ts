// Robust wake-word detection for "Cally".
//
// MentraOS speech-to-text mis-hears the name constantly, and far more so for
// non-US accents (Indian English in particular): "Kali", "Kaali", "Kelly",
// "Colly", "Khali", "Carly", "Golly"... A fixed allow-list can't keep up, so we
// combine an explicit variant set with a phonetic normalisation + edit-distance
// match that accepts anything that *sounds* like "Cally".

// Words we skip when they appear before the wake word ("hey cally", "ok cally").
const FILLERS = new Set(["hey", "hi", "hello", "ok", "okay", "yo", "um", "uh", "so", "hmm"]);

// Common English words that normalise close to "cally" but are almost never the
// wake word — excluded so ordinary speech ("call mom") doesn't trigger Cally.
const STOPWORDS = new Set(["call", "calls", "called", "calling", "caller", "collar", "cola", "colour", "color"]);

// Known-good and frequently mis-heard spellings (exact, post-strip).
const EXPLICIT_VARIANTS = new Set([
  "cally", "caly", "calli", "callie", "calley", "callee", "cali", "calie",
  "kally", "kaly", "kali", "kaali", "kalli", "kallie", "kalley",
  "kelly", "kelli", "kellie", "colly", "collie", "coly", "khali", "khaali",
  "carly", "karli", "karly", "golly", "gally", "kaylee", "kayley", "cally",
]);

const CANON = normalizePhonetic("cally"); // -> "caly"

/** Phonetic squash: hard-C/K/G/KH starts merge, doubled letters collapse. */
function normalizePhonetic(token: string): string {
  let t = token.toLowerCase().replace(/[^a-z]/g, "");
  t = t.replace(/^(kh|k|q|g)/, "c"); // unify hard-consonant onsets to "c"
  t = t.replace(/(.)\1+/g, "$1"); // collapse repeated letters (ll -> l)
  return t;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

export type WakeOptions = {
  /** Extra exact variants (lower-cased, letters only) from configuration. */
  extraVariants?: string[];
  /** Enable phonetic/edit-distance matching beyond the explicit list. */
  fuzzy?: boolean;
  /** Max edit distance on the normalised form for a fuzzy match. */
  maxDistance?: number;
};

/** True if a single token sounds like the wake word. */
export function looksLikeWake(token: string, opts: WakeOptions = {}): boolean {
  const bare = token.toLowerCase().replace(/[^a-z]/g, "");
  if (!bare) return false;
  if (EXPLICIT_VARIANTS.has(bare)) return true;
  if (opts.extraVariants?.includes(bare)) return true;
  if (STOPWORDS.has(bare)) return false;
  if (opts.fuzzy === false) return false;

  const norm = normalizePhonetic(bare);
  if (norm.length < 3 || !norm.startsWith("c")) return false;
  return levenshtein(norm, CANON) <= (opts.maxDistance ?? 1);
}

/**
 * Returns the command spoken after the wake word, "help" if only the wake word
 * was said, or null if no wake word is present. Scans the first few tokens so
 * "hey cally what's up" works while ordinary mid-sentence words don't trigger.
 */
export function extractWakeCommand(text: string, opts: WakeOptions = {}): string | null {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;

  const scan = Math.min(tokens.length, 4);
  for (let i = 0; i < scan; i += 1) {
    const bare = tokens[i].toLowerCase().replace(/[^a-z]/g, "");
    if (!bare) continue;
    if (FILLERS.has(bare)) continue;
    if (looksLikeWake(tokens[i], opts)) {
      const rest = tokens.slice(i + 1).join(" ").replace(/^[\s,:.-]+/, "").trim();
      return rest || "help";
    }
    // First meaningful, non-wake token means this utterance didn't start with
    // the wake word — stop so we don't trigger on a later stray look-alike.
    break;
  }
  return null;
}

export function parseExtraVariants(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.toLowerCase().replace(/[^a-z]/g, ""))
    .filter(Boolean);
}
