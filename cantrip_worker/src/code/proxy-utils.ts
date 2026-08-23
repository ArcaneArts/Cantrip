import type { IncomingMessage } from "node:http";
import type { RawData } from "ws";

const BLOCKED_REQUEST_HEADERS = new Set([
  "authorization",
  "connection",
  "content-length",
  "cookie",
  "host",
  "proxy-authorization",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "x-forwarded-for",
  "x-forwarded-prefix",
  "x-cantrip-code-base-path",
]);
const BLOCKED_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export function rawCodeWebSocketBytes(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

export function editorAuthenticatedPayload(
  payload: Uint8Array,
  connectionToken: string,
): Uint8Array {
  const headerLength = 13;
  if (payload.byteLength < headerLength || payload[0] !== 2) {
    throw new Error(
      "Cantrip Code client sent an invalid authentication frame.",
    );
  }
  const source = Buffer.from(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength,
  );
  const bodyLength = source.readUInt32BE(9);
  if (bodyLength > source.byteLength - headerLength) {
    throw new Error(
      "Cantrip Code client sent a truncated authentication frame.",
    );
  }
  let message: unknown;
  try {
    message = JSON.parse(
      source.subarray(headerLength, headerLength + bodyLength).toString("utf8"),
    );
  } catch {
    throw new Error("Cantrip Code client sent malformed authentication data.");
  }
  if (
    !message ||
    typeof message !== "object" ||
    !("type" in message) ||
    message.type !== "auth"
  ) {
    throw new Error("Cantrip Code client omitted its authentication message.");
  }
  const body = Buffer.from(
    JSON.stringify({ ...message, auth: connectionToken }),
  );
  const trailing = source.subarray(headerLength + bodyLength);
  const translated = Buffer.allocUnsafe(
    headerLength + body.length + trailing.length,
  );
  source.copy(translated, 0, 0, 9);
  translated.writeUInt32BE(body.length, 9);
  body.copy(translated, headerLength);
  trailing.copy(translated, headerLength + body.length);
  return translated;
}

export function codeEditorRequestHeaders(
  headers: Array<[string, string]>,
  target: URL,
  basePath: string,
  connectionToken: string,
): Record<string, string | string[]> {
  const output = new Map<string, string[]>();
  let publicHost: string | undefined;
  for (const [rawName, value] of headers) {
    const name = rawName.toLowerCase();
    if (name === "host" && publicHost === undefined) publicHost = value;
    if (BLOCKED_REQUEST_HEADERS.has(name)) continue;
    const values = output.get(name) ?? [];
    values.push(value);
    output.set(name, values);
  }
  if (!output.has("x-forwarded-host") && publicHost) {
    output.set("x-forwarded-host", [publicHost]);
  }
  output.set("cookie", [`vscode-tkn=${encodeURIComponent(connectionToken)}`]);
  output.set("host", [target.host]);
  output.set("x-forwarded-prefix", [basePath]);
  return Object.fromEntries(
    [...output].map(([name, values]) => [
      name,
      values.length === 1 ? values[0]! : values,
    ]),
  );
}

export function codeEditorResponseHeaders(
  message: IncomingMessage,
): Array<[string, string]> {
  const headers: Array<[string, string]> = [];
  for (let index = 0; index < message.rawHeaders.length; index += 2) {
    const name = message.rawHeaders[index];
    const value = message.rawHeaders[index + 1];
    if (
      !name ||
      value === undefined ||
      BLOCKED_RESPONSE_HEADERS.has(name.toLowerCase())
    )
      continue;
    headers.push([name, value]);
  }
  return headers;
}

export function codeEditorTargetUrl(
  editorOrigin: string,
  rawPath: string,
  basePath: string,
  workspaceUri: string,
): URL {
  const publicUrl = new URL(rawPath, "http://cantrip-surface.invalid");
  if (
    publicUrl.pathname !== basePath &&
    !publicUrl.pathname.startsWith(`${basePath}/`)
  ) {
    throw new Error("Cantrip Code request escaped its attachment path.");
  }
  const target = new URL(editorOrigin);
  target.pathname = publicUrl.pathname.slice(basePath.length) || "/";
  target.search = publicUrl.search;
  // The attachment's workspace is selected by the server and worker. Never
  // allow a renderer-controlled URL to replace that binding, including on
  // secondary HTTP or WebSocket requests that OpenVSCode may interpret.
  target.searchParams.delete("folder");
  target.searchParams.delete("workspace");
  if (
    publicUrl.pathname === basePath ||
    publicUrl.pathname === `${basePath}/`
  ) {
    const workspace = new URL(workspaceUri);
    if (
      workspace.protocol !== "file:" ||
      workspace.host !== "" ||
      workspace.search !== "" ||
      workspace.hash !== ""
    ) {
      throw new Error("Cantrip Code supplied an invalid workspace URI.");
    }
    target.searchParams.set(
      "workspace",
      decodeURIComponent(workspace.pathname),
    );
  }
  return target;
}
