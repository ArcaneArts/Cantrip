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
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-prefix",
  "x-original-host",
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
  for (const [rawName, value] of headers) {
    const name = rawName.toLowerCase();
    if (BLOCKED_REQUEST_HEADERS.has(name)) continue;
    const values = output.get(name) ?? [];
    values.push(value);
    output.set(name, values);
  }
  const publicAuthority = codeEditorPublicAuthority(headers);
  if (publicAuthority) {
    output.set("x-forwarded-host", [publicAuthority]);
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

export function codeEditorPublicAuthority(
  headers: Array<[string, string]>,
): string | undefined {
  const host = headers.find(([name]) => name.toLowerCase() === "host")?.[1];
  if (!host) return undefined;
  try {
    const parsed = new URL(`http://${host}`);
    if (
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      return undefined;
    }
    return parsed.host;
  } catch {
    return undefined;
  }
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

export type CodeEditorPublicStartupSelection =
  { authorized: false } | { authorized: true; initialFileUri?: string };

export function codeEditorPublicStartupSelection(
  rawPath: string,
  basePath: string,
  workspaceUri: string,
  publicAuthority?: string,
): CodeEditorPublicStartupSelection {
  const publicUrl = new URL(rawPath, "http://cantrip-surface.invalid");
  if (
    publicUrl.pathname !== basePath &&
    publicUrl.pathname !== `${basePath}/`
  ) {
    return { authorized: true };
  }
  let workspace: URL;
  let workspacePath: string;
  try {
    workspace = new URL(workspaceUri);
    if (
      workspace.protocol !== "file:" ||
      workspace.search !== "" ||
      workspace.hash !== ""
    ) {
      return { authorized: false };
    }
    workspacePath = workspace.host
      ? `//${workspace.host}${decodeURIComponent(workspace.pathname)}`
      : decodeURIComponent(workspace.pathname);
  } catch {
    return { authorized: false };
  }
  if (
    publicUrl.searchParams.has("folder") ||
    publicUrl.searchParams.has("ew") ||
    publicUrl.searchParams.getAll("workspace").length > 1 ||
    (publicUrl.searchParams.has("workspace") &&
      publicUrl.searchParams.get("workspace") !== workspacePath)
  ) {
    return { authorized: false };
  }
  const payloads = publicUrl.searchParams.getAll("payload");
  if (payloads.length === 0) return { authorized: true };
  if (payloads.length !== 1 || !publicAuthority) {
    return { authorized: false };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(payloads[0]!);
  } catch {
    return { authorized: false };
  }
  if (
    !Array.isArray(payload) ||
    payload.length !== 1 ||
    !Array.isArray(payload[0]) ||
    payload[0].length !== 2 ||
    payload[0][0] !== "openFile" ||
    typeof payload[0][1] !== "string"
  ) {
    return { authorized: false };
  }
  let remoteFile: URL;
  try {
    remoteFile = new URL(payload[0][1]);
  } catch {
    return { authorized: false };
  }
  if (
    remoteFile.protocol !== "vscode-remote:" ||
    remoteFile.host !== publicAuthority.toLowerCase() ||
    remoteFile.username !== "" ||
    remoteFile.password !== "" ||
    remoteFile.search !== "" ||
    remoteFile.hash !== ""
  ) {
    return { authorized: false };
  }
  let initialFileUri: string;
  try {
    if (remoteFile.pathname.startsWith("//")) {
      const hostBoundary = remoteFile.pathname.indexOf("/", 2);
      if (hostBoundary < 3) return { authorized: false };
      const host = remoteFile.pathname.slice(2, hostBoundary);
      const filePath = remoteFile.pathname.slice(hostBoundary);
      initialFileUri = new URL(`file://${host}${filePath}`).href;
    } else {
      initialFileUri = new URL(`file://${remoteFile.pathname}`).href;
    }
  } catch {
    return { authorized: false };
  }
  return { authorized: true, initialFileUri };
}

export function codeEditorTargetUrl(
  editorOrigin: string,
  rawPath: string,
  basePath: string,
  workspaceUri: string,
  initialFileUri: string | null = null,
  publicAuthority?: string,
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
  target.searchParams.delete("payload");
  target.searchParams.delete("workspace");
  target.searchParams.delete("ew");
  if (
    publicUrl.pathname === basePath ||
    publicUrl.pathname === `${basePath}/`
  ) {
    const workspace = new URL(workspaceUri);
    if (
      workspace.protocol !== "file:" ||
      workspace.search !== "" ||
      workspace.hash !== ""
    ) {
      throw new Error("Cantrip Code supplied an invalid workspace URI.");
    }
    target.searchParams.set(
      "workspace",
      workspace.host
        ? `//${workspace.host}${decodeURIComponent(workspace.pathname)}`
        : decodeURIComponent(workspace.pathname),
    );
    if (initialFileUri) {
      if (!publicAuthority) {
        throw new Error(
          "Cantrip Code could not establish its public editor authority.",
        );
      }
      const initialFile = new URL(initialFileUri);
      if (
        initialFile.protocol !== "file:" ||
        initialFile.search !== "" ||
        initialFile.hash !== ""
      ) {
        throw new Error("Cantrip Code supplied an invalid initial file URI.");
      }
      const remotePath = initialFile.host
        ? `//${initialFile.host}${initialFile.pathname}`
        : initialFile.pathname;
      const remoteFile = new URL(
        `vscode-remote://${publicAuthority}${remotePath}`,
      );
      target.searchParams.set(
        "payload",
        JSON.stringify([["openFile", remoteFile.href]]),
      );
    }
  }
  return target;
}
