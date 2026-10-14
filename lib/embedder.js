const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Lists model IDs currently loaded in the LM Studio server (non-fatal).
export async function listModels(baseUrl, { timeoutMs = 10000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/v1/models`, {
      headers: { accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!res.ok) return [];
    const json = await res.json();
    return (json.data || []).map((m) => m.id);
  } catch {
    return [];
  } finally {
    clearTimeout(t);
  }
}

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
    const data = Array.isArray(json.data) ? json.data : [];
    // OpenAI-compatible endpoints return { index, embedding } objects, and the
    // array order is NOT guaranteed to match the request. Sort by index so a
    // vector is never attached to the wrong chunk.
    const ordered = data.slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    if (ordered.length !== batch.length) {
      console.error(`[rss-rag] Embedding response size mismatch: expected ${batch.length}, got ${ordered.length}`);
    }
    return ordered.map((d) => new Float32Array(d.embedding));
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

// L2 norm, stored per chunk so cosine similarity avoids re-normalising vectors.
export function vectorNorm(a) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * a[i];
  return Math.sqrt(s);
}

export function dot(a, b) {
  const n = Math.min(a.length, b.length);
  let d = 0;
  for (let i = 0; i < n; i++) d += a[i] * b[i];
  return d;
}

export function float32ToBuffer(arr) { return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength); }
export function bufferToFloat32(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  // Copy into a fresh, byteOffset-0 buffer: a SQLite BLOB view can have a
  // byteOffset that is not a multiple of 4, which would make the Float32Array
  // constructor throw a RangeError.
  return new Float32Array(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
}