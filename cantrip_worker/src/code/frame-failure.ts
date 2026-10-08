import type { IncomingMessage, ServerResponse } from "node:http";
import {
  CODE_WORKBENCH_FRAME_NONCE_PARAMETER,
  codeWorkbenchFrameFailureMessageSchema,
} from "@cantrip/protocol/code-workbench-frame";

// Report the actual failed navigation, not a separate reachability probe.
// Only mounted root documents may turn an HTTP failure into a frame signal;
// asset and control responses must retain their original bodies and semantics.
export function writeCodeWorkbenchFrameFailure(
  request: Pick<IncomingMessage, "method" | "url">,
  response: ServerResponse,
  basePath: string | undefined,
  statusCode: number,
): boolean {
  if (
    request.method !== "GET" ||
    !basePath ||
    response.headersSent ||
    statusCode < 400
  ) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(request.url ?? "/", "http://cantrip-code.invalid");
  } catch {
    return false;
  }
  if (url.pathname !== basePath && url.pathname !== `${basePath}/`) {
    return false;
  }
  const nonces = url.searchParams.getAll(CODE_WORKBENCH_FRAME_NONCE_PARAMETER);
  if (nonces.length !== 1) return false;
  const parsed = codeWorkbenchFrameFailureMessageSchema.safeParse({
    type: "cantrip-code.frame-load-failed",
    version: 1,
    nonce: nonces[0],
    statusCode,
  });
  if (!parsed.success) return false;
  const { nonce } = parsed.data;
  response
    .writeHead(statusCode, {
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'`,
      "x-content-type-options": "nosniff",
    })
    .end(
      `<!doctype html><meta charset="utf-8"><script nonce="${nonce}">window.parent.postMessage(${JSON.stringify(parsed.data)}, "*");</script>`,
    );
  return true;
}
