// Keep reading an actual early rejection while uploading. A reset without a
// complete response remains an error; no request is retried.
import http from "node:http";
import https from "node:https";
import { setImmediate as nextTurn } from "node:timers/promises";

export function streamingHttpRequest(url, { method, headers, body, signal }) {
  return httpRequest(url, { method, headers, body, signal }, true);
}

export function headersOnlyHttpRequest(url, options) {
  return httpRequest(url, options, false);
}

function httpRequest(url, { method, headers, body, signal }, sendBody) {
  const bytes = Buffer.from(body ?? "");
  return new Promise((resolve, reject) => {
    let responseStarted = false;
    let settled = false;
    const request = (new URL(url).protocol === "https:" ? https : http).request(
      url,
      {
        method,
        headers: sendBody
          ? { ...headers, "transfer-encoding": "chunked" }
          : headers,
        agent: false,
        signal,
      },
      (response) => {
        responseStarted = true;
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.once("error", fail);
        response.once("end", () => {
          if (settled) return;
          try {
            const actualHeaders = new Headers();
            for (let i = 0; i < response.rawHeaders.length; i += 2)
              actualHeaders.append(
                response.rawHeaders[i],
                response.rawHeaders[i + 1],
              );
            const result = new Response(Buffer.concat(chunks), {
              status: response.statusCode,
              statusText: response.statusMessage,
              headers: actualHeaders,
            });
            settled = true;
            request.destroy();
            resolve(result);
          } catch (error) {
            fail(error);
          }
        });
      },
    );
    function fail(error) {
      if (settled) return;
      settled = true;
      request.destroy();
      reject(error);
    }
    request.once("error", (error) => {
      // Once headers arrive, the incoming stream determines whether the reply
      // is complete. A write failure must not discard that actual response.
      if (!responseStarted) fail(error);
    });
    async function upload() {
      for (let at = 0; at < bytes.length; at += 16 * 1024) {
        if (settled || responseStarted) return;
        if (!request.write(bytes.subarray(at, at + 16 * 1024))) {
          await new Promise((resolve) => {
            const done = () => {
              request.off("drain", done);
              request.off("close", done);
              request.off("response", done);
              resolve();
            };
            request.once("drain", done);
            request.once("close", done);
            request.once("response", done);
          });
        }
        // Give the socket's real response a turn before the next body write.
        await nextTurn();
      }
      if (!settled && !responseStarted) request.end();
    }
    if (sendBody) upload().catch(fail);
    else request.flushHeaders();
  });
}
