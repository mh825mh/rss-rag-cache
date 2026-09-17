const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function embedOne(batch, { baseUrl, model, timeoutMs }) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/v1/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, input: batch }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      throw new Error(`Embedding request failed: ${res.status} ${body}`);
    }
    const json = await res.json();
    return json.data.map((d) => new Float32Array(d.embedding));
  } finally {
    clearTimeout(t);
  }
}

// Returns a vector per input text. Failed batches yield null (caller stores
// text-only chunks) instead of failing the whole refresh. Throws only if a
// single-light request also fails (used for query embeddings).
export async function embed(texts, { baseUrl, model, batchSize = 16, timeoutMs = 60000, retries = 1 } = {}) {
  if (!texts.length) return [];
  if (!baseUrl || !model) {
    throw new Error("embed() requires baseUrl and model");
  }

  const out = new Array(texts.length).fill(null);
  let failures = 0;

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const vecs = await embedOne(batch, { baseUrl, model, timeoutMs });
        for (let j = 0; j < vecs.length; j++) out[i + j] = vecs[j];
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        if (attempt < retries) await sleep(500 * (attempt + 1));
      }
    }
    if (lastErr) {
      failures++;
      console.error(`[rss-rag] Embedding batch ${i / batchSize + 1} failed (${Math.ceil((i + batch.length) / batchSize)}): ${lastErr.message}`);
    }
  }

  if (failures > 0 && texts.length === 1 && !out[0]) {
    throw new Error("Embedding request failed");
  }
  return out;
}

export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function float32ToBuffer(arr) { return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength); }
export function bufferToFloat32(buf) { return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4); }