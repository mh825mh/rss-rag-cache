// Optional late re-ranking via LM Studio's rerank endpoint.
//
// RRF + MMR give good recall and diversity, but a cross-encoder reranker can
// lift precision on ambiguous queries far beyond what rank fusion can. The
// feature is opt-in (`rerankDocs` setting, 0 = off), degrades silently, and
// never changes results when no reranker model is loaded.
//
// Availability: LM Studio exposes /v1/rerank when a reranker model is loaded.
// There are two accepted request shapes: some servers want no `model` field,
// others require one. A successful shape is remembered for the process
// lifetime; a failure (endpoint absent or no reranker loaded) is remembered
// for 10 minutes so a busy chat doesn't re-probe on every query.

const PROBE_TTL_MS = 10 * 60 * 1000;

let availability = null; // { usable, body: "plain" | "model", at }

const probeFresh = () => availability && Date.now() - availability.at < PROBE_TTL_MS;

async function postRerank(baseUrl, body, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${String(baseUrl).replace(/\/+$/, "")}/v1/rerank`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const err = new Error(`rerank HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// Accepts both plausible response shapes:
//   { results: [{ index, relevance_score }] } and { data: [...] }
function orderFromResponse(payload) {
  const list = payload?.results ?? payload?.data ?? null;
  if (!Array.isArray(list)) return null;
  const order = [];
  for (const item of list) {
    const idx = Number(item?.index);
    if (Number.isInteger(idx) && idx >= 0) order.push(idx);
  }
  return order.length ? order : null;
}

function applyOrder(items, order) {
  const out = [];
  const seen = new Set();
  for (const idx of order) {
    if (idx < items.length && !seen.has(idx)) {
      seen.add(idx);
      out.push(items[idx]);
    }
  }
  for (let i = 0; i < items.length; i++) if (!seen.has(i)) out.push(items[i]);
  return out;
}

// Re-orders `items` best-first. Each item must carry a `rerankText` property
// (the document the reranker scores). Returns a NEW array, or null when
// reranking is unavailable, disabled or failed — callers must keep the
// original order in that case. Never throws.
export async function rerankItems(query, items, settings, { timeoutMs = 8000 } = {}) {
  if (!query || !items?.length) return null;
  const base = String(settings?.lmStudioBaseUrl || "").trim();
  if (!base || !Number(settings?.rerankDocs)) return null;

  // A previously failed probe suppresses retries until its TTL expires.
  if (availability && !availability.usable && probeFresh()) return null;

  const docTexts = items.map((it) => String(it.rerankText ?? "").slice(0, 4000));
  if (docTexts.some((t) => !t.trim())) return null;

  const attempts = [];
  if (availability?.usable && availability.body) {
    attempts.push({ body: availability.body, withModel: availability.body === "model" });
  } else {
    attempts.push({ body: "plain", withModel: false }, { body: "model", withModel: true });
  }

  for (const attempt of attempts) {
    try {
      const body = { query, documents: docTexts, top_n: items.length };
      if (attempt.withModel) body.model = settings.embeddingModel;
      const payload = await postRerank(base, body, timeoutMs);
      const order = orderFromResponse(payload);
      if (!order) throw new Error("unexpected rerank response");
      availability = { usable: true, body: attempt.body, at: Date.now() };
      return applyOrder(items, order);
    } catch {
      // try the next request shape
    }
  }

  if (!availability?.usable) {
    availability = { usable: false, body: null, at: Date.now() };
  }
  return null;
}

// Test hook: forget the cached probe result.
export function resetRerankProbe() {
  availability = null;
}
