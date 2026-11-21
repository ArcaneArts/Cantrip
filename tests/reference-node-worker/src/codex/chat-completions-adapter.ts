import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { normalizeResponsesBaseUrl } from "@cantrip/protocol";
import type { RuntimeProvider } from "../protected-secrets.js";
import {
  AdapterProtocolError,
  chatCompletionFailureMessage,
  chatCompletionsRequest,
  object,
} from "./chat-completions-request.js";
import {
  chatCompletionEvents,
  ResponsesCompletionStream,
} from "./chat-completions-stream.js";

function fail(response: ServerResponse, status: number, message: string) {
  if (response.destroyed || response.writableEnded) return;
  const error = {
    type: "invalid_request_error",
    code: "chat_completions_error",
    message,
  };
  if (response.headersSent)
    response.end(
      `data: ${JSON.stringify({ type: "response.failed", response: { status: "failed", error } })}\n\n`,
    );
  else
    response
      .writeHead(status, { "content-type": "application/json" })
      .end(JSON.stringify({ error }));
}

/** Private, ephemeral loopback bridge. Credentials never enter its address. */
export async function startChatCompletionsAdapter(provider: RuntimeProvider) {
  const token = randomBytes(32).toString("hex");
  const expectedAuth = Buffer.from(`Bearer ${token}`);
  const controllers = new Set<AbortController>();
  const server = createServer(async (request, response) => {
    const supplied = Buffer.from(request.headers.authorization ?? "");
    if (
      supplied.length !== expectedAuth.length ||
      !timingSafeEqual(supplied, expectedAuth)
    ) {
      fail(
        response,
        401,
        "The private inference adapter rejected authentication.",
      );
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/responses") {
      fail(
        response,
        404,
        "The private inference adapter only accepts Responses requests.",
      );
      return;
    }
    const controller = new AbortController();
    controllers.add(controller);
    const cancel = () => {
      if (!response.writableFinished) controller.abort();
    };
    response.on("close", cancel);
    request.on("aborted", cancel);
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 64 * 1024 * 1024)
          throw new AdapterProtocolError(
            "The inference request exceeded 64 MiB.",
          );
        chunks.push(Buffer.from(chunk));
      }
      let raw: unknown;
      try {
        raw = JSON.parse(Buffer.concat(chunks).toString());
      } catch {
        throw new AdapterProtocolError(
          "The Responses request was not valid JSON.",
        );
      }
      const translated = chatCompletionsRequest(raw);
      let upstream: Response;
      try {
        upstream = await fetch(
          `${normalizeResponsesBaseUrl(provider.baseUrl)}/chat/completions`,
          {
            method: "POST",
            redirect: "error",
            headers: {
              "content-type": "application/json",
              accept: "text/event-stream",
              ...(provider.apiKey
                ? { authorization: `Bearer ${provider.apiKey}` }
                : {}),
            },
            body: JSON.stringify(translated.body),
            signal: controller.signal,
          },
        );
      } catch (error) {
        const cause = error instanceof Error ? error.cause : null;
        const code =
          cause && typeof cause === "object" && "code" in cause
            ? String(cause.code)
            : "";
        const reason =
          code === "ECONNREFUSED"
            ? "Connection refused."
            : ["ENOTFOUND", "EAI_AGAIN"].includes(code)
              ? "DNS resolution failed."
              : /CERT|TLS|SSL/.test(code)
                ? "TLS connection failed."
                : "The endpoint could not be reached.";
        if (!controller.signal.aborted)
          fail(response, 502, `Chat Completions connection failed. ${reason}`);
        return;
      }
      if (!upstream.ok) {
        // Inspect only a bounded prefix to classify; never relay private bodies.
        const reader = upstream.body?.getReader();
        const first = await reader?.read();
        await reader?.cancel().catch(() => undefined);
        reader?.releaseLock();
        const detail = new TextDecoder().decode(
          first?.value?.subarray(0, 8192),
        );
        fail(
          response,
          upstream.status,
          `${chatCompletionFailureMessage(detail)} HTTP ${upstream.status}.`,
        );
        return;
      }
      if (!upstream.body)
        throw new AdapterProtocolError(
          "The Chat Completions response was empty.",
        );
      const stream = object(raw).stream !== false;
      if (stream)
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
        });
      const completion = new ResponsesCompletionStream((event) => {
        if (stream && !response.destroyed)
          response.write(`data: ${JSON.stringify(event)}\n\n`);
      }, String(translated.body.model));
      completion.start();
      if (upstream.headers.get("content-type")?.includes("text/event-stream")) {
        for await (const packet of chatCompletionEvents(upstream.body))
          completion.accept(packet);
      } else {
        // Some compatible deployments ignore streaming. Bound the JSON body.
        const reader = upstream.body.getReader();
        const buffers: Uint8Array[] = [];
        let length = 0;
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > 64 * 1024 * 1024)
              throw new AdapterProtocolError(
                "The model output exceeded 64 MiB.",
              );
            buffers.push(value);
          }
          let packet: unknown;
          try {
            packet = JSON.parse(Buffer.concat(buffers).toString());
          } catch {
            throw new AdapterProtocolError(
              "The Chat Completions response was not valid JSON.",
            );
          }
          completion.accept(packet);
        } finally {
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
      }
      const result = completion.finish(translated);
      if (stream) response.end();
      else
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify(result));
    } catch (error) {
      if (!controller.signal.aborted)
        fail(
          response,
          400,
          error instanceof AdapterProtocolError
            ? error.message
            : "The Chat Completions adapter failed.",
        );
    } finally {
      controllers.delete(controller);
      response.off("close", cancel);
      request.off("aborted", cancel);
    }
  });
  server.requestTimeout = 30_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  server.unref();
  const address = server.address();
  if (!address || typeof address === "string")
    throw new AdapterProtocolError("The inference adapter did not bind.");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiKey: token,
    close() {
      for (const controller of controllers) controller.abort();
      controllers.clear();
      server.closeAllConnections();
      server.close();
    },
  };
}
