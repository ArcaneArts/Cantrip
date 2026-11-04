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
}
