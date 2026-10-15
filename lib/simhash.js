// 64-bit SimHash over lowercased word tokens using 3-gram shingles.
// Used to collapse syndicated near-duplicate articles whose bodies are similar.
const FNV_OFFSET = BigInt("0xcbf29ce484222325");
const FNV_PRIME = BigInt("0x100000001b3");
const STOP = new Set([
  "the", "and", "for", "that", "with", "this", "from", "are", "was", "were",
  "has", "have", "had", "but", "not", "you", "your", "its", "their", "they",
  "them", "his", "her", "she", "him", "our", "out", "who", "what", "when",
  "where", "which", "will", "would", "can", "could", "should", "about", "into",
  "over", "after", "before", "than", "then", "also", "more", "most", "some",
  "such", "only", "other", "new", "said", "says", "one", "two", "how", "why",
]);

function fnv1a64(str) {
  let h = FNV_OFFSET;
  for (let i = 0; i < str.length; i++) {
    h ^= BigInt(str.charCodeAt(i));
    h = (h * FNV_PRIME) & BigInt("0xffffffffffffffff");
  }
  return h & BigInt("0xffffffffffffffff");
}

function toBigInt(v) {
  if (v == null) return null;
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.trunc(v));
  return null;
}

function bigIntPopcount(x) {
  let v = BigInt(x);
  let c = 0n;
  while (v) {
    c += v & 1n;
    v >>= 1n;
  }
  return Number(c);
}

// Compute 64-bit SimHash over word tokens. Uses 3-gram shingles of words.
export function computeSimhash(text) {
  const toks = String(text || "").toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || [];
  const tokens = toks.filter((t) => !STOP.has(t));
  if (!tokens.length) return null;
  const counts = new Map();
  let total = 0;
  // Build 3-gram shingles
  for (let i = 0; i <= tokens.length - 3; i++) {
    const sh = tokens[i] + " " + tokens[i + 1] + " " + tokens[i + 2];
    counts.set(sh, (counts.get(sh) || 0) + 1);
    total++;
  }
  // If too few 3-grams, fall back to bigrams/unigrams
  if (total < 2 && tokens.length >= 2) {
    for (let i = 0; i <= tokens.length - 2; i++) {
      const sh = tokens[i] + " " + tokens[i + 1];
      counts.set(sh, (counts.get(sh) || 0) + 1);
      total++;
    }
  }
  if (total < 1) {
    for (const t of tokens) {
      counts.set(t, (counts.get(t) || 0) + 1);
      total++;
    }
  }
  if (!total) return null;

  const v = new Array(64).fill(0);
  for (const [t, w] of counts) {
    const h = fnv1a64(t);
    const weight = 1 + Math.log(w);
    for (let i = 0; i < 64; i++) {
      const bit = (h & (1n << BigInt(i))) !== 0n;
      if (bit) v[i] += weight;
      else v[i] -= weight;
    }
  }
  let out = 0n;
  for (let i = 0; i < 64; i++) {
    if (v[i] > 0) out |= (1n << BigInt(i));
  }
  return out & BigInt("0xffffffffffffffff");
}

// SQLite binds BigInt as a *signed* 64-bit integer, so an unsigned SimHash must
// be converted to its two's-complement signed form before it is stored. Values
// that fit in the signed range are unchanged.
export function toStoredSimhash(v) {
  if (v == null) return null;
  return BigInt.asIntN(64, BigInt(v));
}

// Inverse of toStoredSimhash: normalises a value read back from the database
// (which may be unsigned, signed, a BigInt, or a legacy 32-bit Number).
export function fromStoredSimhash(v) {
  if (v == null) return null;
  return BigInt.asUintN(64, BigInt(v));
}

// Hamming distance between two 64-bit simhashes. Missing values are maximally
// distant. Both operands are normalised to 64 bits first, so signed values read
// back from SQLite compare correctly against freshly-computed unsigned ones.
export function hamming(a, b) {
  if (a == null || b == null) return 128;
  const ba = toBigInt(a);
  const bb = toBigInt(b);
  if (ba == null || bb == null) return 128;
  const xor = BigInt.asUintN(64, ba) ^ BigInt.asUintN(64, bb);
  return bigIntPopcount(xor);
}

