/** Bounded native discovery, independent of the smaller control-channel pages. */
export async function fetchModelCatalogJson(
  url: string | URL,
  apiKey: string | null,
  fetcher: typeof fetch,
  timeoutMs: number,
  signal?: AbortSignal,
  init: RequestInit = {},
): Promise<unknown> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.body) headers.set("content-type", "application/json");
  if (apiKey) headers.set("authorization", `Bearer ${apiKey}`);
  const response = await fetcher(url, {
    ...init,
    headers,
    signal: AbortSignal.any([
      AbortSignal.timeout(timeoutMs),
      ...(signal ? [signal] : []),
    ]),
    redirect: "error",
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Model catalog request returned HTTP ${response.status}.`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Model catalog response was empty.");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 16 * 1024 * 1024)
        throw new Error("Model catalog response exceeded 16 MiB.");
      chunks.push(value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new Error("Model catalog response was not valid JSON.");
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
