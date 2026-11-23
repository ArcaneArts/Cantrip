export const CANTRIP_MCP_MAX_RESPONSE_BYTES = 512 * 1_024;

export async function readBoundedJsonResponse(
  response: Response | import("undici").Response,
  maximumBytes: number,
): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel();
    throw new Error("Cantrip MCP response is too large.");
  }
  if (!response.body) throw new Error("Cantrip MCP response body is missing.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel();
        throw new Error("Cantrip MCP response is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (!chunks.length) throw new Error("Cantrip MCP response body is empty.");
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}
