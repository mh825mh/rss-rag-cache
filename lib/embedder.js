export async function embed(texts, { baseUrl, model }) {
  if (!texts.length) return [];
  const res = await fetch(`${baseUrl}/v1/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, input: texts }),
  });
  if (!res.ok) throw new Error(`Embedding request failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return json.data.map((d) => new Float32Array(d.embedding));
}

export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function float32ToBuffer(arr) { return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength); }
export function bufferToFloat32(buf) { return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4); }