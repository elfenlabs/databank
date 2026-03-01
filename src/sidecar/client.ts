const EMBED_URL = process.env.EMBED_URL;
if (!EMBED_URL) {
  throw new Error("EMBED_URL environment variable is required");
}

/**
 * Embed a single text string via the sidecar.
 * Returns a vector (number[]) matching the sidecar model's dimension.
 */
export async function embed(text: string): Promise<number[]> {
  const res = await fetch(`${EMBED_URL}/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });

  if (!res.ok) {
    throw new Error(`Sidecar error ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as { vector: number[] };
  return data.vector;
}

/**
 * Embed multiple texts in a single request.
 * Returns an array of vectors, one per input text.
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const res = await fetch(`${EMBED_URL}/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ texts }),
  });

  if (!res.ok) {
    throw new Error(`Sidecar error ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as { vectors: number[][] };
  return data.vectors;
}
