import { execFile } from "node:child_process";
import { request as httpRequest } from "node:http";
import { promisify } from "node:util";

const execute = promisify(execFile);

/** A failed carrier never implies that a Docker mutation can be replayed. */
export class DockerDeliveryError extends Error {
  delivery = "unknown";
}

export class DockerApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Local Engine API used by both the worker and pnpm os. The daemon socket is
 * opened only on the host; it is never mounted or forwarded into CantripOS. */
export class LocalDocker {
  constructor(socketPath) {
    this.socketPath = socketPath;
  }

  static async current() {
    let endpoint = !process.env.DOCKER_CONTEXT
      ? process.env.DOCKER_HOST
      : undefined;
    if (!endpoint) {
      const { stdout } = await execute("docker", ["context", "inspect"], {
        maxBuffer: 1024 * 1024,
      });
      endpoint = JSON.parse(stdout)[0].Endpoints.docker.Host;
    }
    if (endpoint.startsWith("unix://"))
      return new LocalDocker(decodeURIComponent(new URL(endpoint).pathname));
    if (endpoint.startsWith("npipe://"))
      return new LocalDocker(
        endpoint.slice("npipe://".length).replaceAll("/", "\\"),
      );
    throw new Error(
      "Linked CantripOS sources require a local Docker Unix socket or named pipe. Use a local Docker context or a Linux-owned SSH target.",
    );
  }

  request(method, path, body, { timeout = 60_000, signal } = {}) {
    const payload =
      body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const request = httpRequest(
        {
          socketPath: this.socketPath,
          signal,
          method,
          path: `/v1.41${path}`,
          headers: payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": payload.length,
              }
            : {},
        },
        (response) => {
          const chunks = [];
          let size = 0;
          response.on("data", (chunk) => {
            size += chunk.length;
            if (size > 4 * 1024 * 1024)
              request.destroy(
                new DockerDeliveryError(
                  "Docker response exceeded the receipt limit; mutation outcome may be unknown.",
                ),
              );
            else chunks.push(chunk);
          });
          response.once("error", (error) =>
            reject(
              new DockerDeliveryError(
                `Docker response disconnected: ${error.message}`,
              ),
            ),
          );
          response.once("end", () => {
            let receipt;
            try {
              const text = Buffer.concat(chunks).toString("utf8");
              receipt = text ? JSON.parse(text) : null;
            } catch {
              reject(
                new DockerDeliveryError(
                  "Docker returned an invalid receipt; no operation was replayed.",
                ),
              );
              return;
            }
            if (response.statusCode >= 400)
              reject(
                new DockerApiError(
                  response.statusCode,
                  receipt?.message ?? `Docker HTTP ${response.statusCode}`,
                ),
              );
            else resolve(receipt);
          });
        },
      );
      request.setTimeout(timeout, () =>
        request.destroy(
          new DockerDeliveryError(
            "Docker request timed out; reconcile the container before retrying.",
          ),
        ),
      );
      request.once("error", (error) =>
        reject(
          error instanceof DockerDeliveryError
            ? error
            : new DockerDeliveryError(
                `Docker request disconnected: ${error.message}`,
              ),
        ),
      );
      request.end(payload);
    });
  }

  inspect(container, options) {
    return this.request(
      "GET",
      `/containers/${encodeURIComponent(container)}/json`,
      undefined,
      options,
    );
  }

  /** Stream a verified private tar without JSON-encoding or buffering it.
   * Completion is not image identity proof; callers must inspect the exact ID.
   * No upload is retried, including after a lost receipt. */
  loadImage(source, { timeout = 300_000, signal } = {}) {
    return new Promise((resolve, reject) => {
      let response,
        finished = false,
        receipt;
      const complete = () => {
        if (finished && receipt !== undefined) resolve(receipt);
      };
      const request = httpRequest(
        {
          socketPath: this.socketPath,
          signal,
          method: "POST",
          path: "/v1.41/images/load?quiet=true",
          headers: { "Content-Type": "application/x-tar" },
        },
        (incoming) => {
          response = incoming;
          if (incoming.statusCode !== 200) source.unpipe(request);
          const chunks = [];
          let size = 0;
          incoming.on("data", (bytes) => {
            size += bytes.length;
            if (size > 4 * 1024 * 1024)
              request.destroy(
                new DockerDeliveryError(
                  "Docker image-load receipt exceeded its limit; outcome is unknown.",
                ),
              );
            else chunks.push(bytes);
          });
          incoming.once("error", (error) =>
            reject(
              incoming.statusCode !== 200
                ? new DockerApiError(
                    incoming.statusCode,
                    `Docker image-load response disconnected: ${error.message}`,
                  )
                : new DockerDeliveryError(
                    `Docker image-load response disconnected: ${error.message}`,
                  ),
            ),
          );
          incoming.once("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            if (incoming.statusCode !== 200) {
              let message = text.slice(0, 16384);
              try {
                message = JSON.parse(text).message ?? message;
              } catch {
                /* Actual non-JSON refusal. */
              }
              reject(
                new DockerApiError(
                  incoming.statusCode,
                  message || `Docker HTTP ${incoming.statusCode}`,
                ),
              );
              source.unpipe(request);
              request.destroy();
              return;
            }
            try {
              receipt = text
                .split("\n")
                .filter((line) => line.trim())
                .map((line) => JSON.parse(line));
              const error = receipt.find(
                (entry) => entry.error || entry.errorDetail,
              );
              if (error)
                throw new DockerDeliveryError(
                  `Docker image load reported: ${error.error ?? error.errorDetail.message}`,
                );
              complete();
            } catch (error) {
              reject(
                error instanceof DockerDeliveryError
                  ? error
                  : new DockerDeliveryError(
                      "Docker returned an invalid image-load receipt; outcome is unknown.",
                    ),
              );
            }
          });
        },
      );
      request.setTimeout(timeout, () =>
        request.destroy(
          new DockerDeliveryError(
            "Docker image load timed out; outcome is unknown.",
          ),
        ),
      );
      request.once("finish", () => {
        finished = true;
        complete();
      });
      request.on("error", (error) => {
        source.unpipe(request);
        if (response && response.statusCode !== 200) return;
        reject(
          error instanceof DockerDeliveryError
            ? error
            : new DockerDeliveryError(
                `Docker image load disconnected: ${error.message}`,
              ),
        );
      });
      const inputError = (error) =>
        request.destroy(
          new DockerDeliveryError(
            `Docker image input failed: ${error.message}`,
          ),
        );
      source.once("error", inputError);
      request.once("close", () => {
        source.unpipe(request);
        source.destroy();
      });
      source.once("close", () => source.removeListener("error", inputError));
      source.pipe(request);
    }).finally(() => source.destroy());
  }

  /** Bounded JSON receipts and unbounded streamed image bytes have separate
   * lifetimes. Consumers must drain/destroy this GET stream; it is never retried. */
  readStream(path, { timeout = 300_000, signal } = {}) {
    return new Promise((resolve, reject) => {
      let response;
      const request = httpRequest(
        {
          socketPath: this.socketPath,
          signal,
          method: "GET",
          path: `/v1.41${path}`,
        },
        (incoming) => {
          response = incoming;
          incoming.on("error", () => {});
          if (incoming.statusCode !== 200) {
            let diagnostic = "";
            incoming.setEncoding("utf8");
            incoming.on("data", (chunk) => {
              if (diagnostic.length + chunk.length > 16384) {
                incoming.destroy(
                  new DockerApiError(
                    incoming.statusCode,
                    "Docker archive error response exceeded the diagnostic limit.",
                  ),
                );
              } else diagnostic += chunk;
            });
            incoming.once("error", reject);
            incoming.once("end", () => {
              let message = `Docker HTTP ${incoming.statusCode}`;
              try {
                message = JSON.parse(diagnostic).message ?? message;
              } catch {
                /* Actual non-JSON error. */
              }
              reject(new DockerApiError(incoming.statusCode, message));
            });
          } else resolve(incoming);
        },
      );
      request.setTimeout(timeout, () =>
        request.destroy(
          new DockerDeliveryError(
            "Docker archive stream timed out; no operation was replayed.",
          ),
        ),
      );
      request.once("error", (cause) => {
        const error =
          cause instanceof DockerDeliveryError ||
          cause instanceof DockerApiError
            ? cause
            : new DockerDeliveryError(
                `Docker archive stream disconnected: ${cause.message}`,
              );
        if (response) response.destroy(error);
        reject(error);
      });
      request.end();
    });
  }
}
