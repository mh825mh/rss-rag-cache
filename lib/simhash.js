// 32-bit SimHash over lowercased word tokens. Used to collapse syndicated
// near-duplicate articles whose headlines differ but whose bodies are the same.

const STOP = new Set([
  "the", "and", "for", "that", "with", "this", "from", "are", "was", "were",
  "has", "have", "had", "but", "not", "you", "your", "its", "their", "they",
  "them", "his", "her", "she", "him", "our", "out", "who", "what", "when",
  "where", "which", "will", "would", "can", "could", "should", "about", "into",
  "over", "after", "before", "than", "then", "also", "more", "most", "some",
  "such", "only", "other", "new", "said", "says", "one", "two", "how", "why",
]);

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

// Returns an unsigned 32-bit integer, or null when there are no usable tokens.
export function computeSimhash(text) {
  const toks = String(text || "").toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [];
  const counts = new Map();
  let total = 0;
  for (const t of toks) {
    if (STOP.has(t)) continue;
    counts.set(t, (counts.get(t) || 0) + 1);
    total++;
  }
  if (!total) return null;

  const v = new Array(32).fill(0);
  for (const [t, w] of counts) {
    const h = fnv1a(t);
    const weight = 1 + Math.log(w);
    for (let i = 0; i < 32; i++) v[i] += (h & (1 << i)) ? weight : -weight;
  }
  let out = 0;
  for (let i = 0; i < 32; i++) if (v[i] > 0) out |= (1 << i);
  return out >>> 0;
}

// Hamming distance between two 32-bit simhashes. Missing values are maximally distant.
export function hamming(a, b) {
  if (a == null || b == null) return 64;
  let x = (Number(a) ^ Number(b)) >>> 0;
  let c = 0;
  while (x) { x &= x - 1; c++; }
  return c;
}
