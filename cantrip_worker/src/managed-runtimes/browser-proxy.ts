import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type Server as HttpServer } from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import type { Duplex } from "node:stream";

import {
  normalizedPublicHttpUrl,
  resolvePublicAddresses,
} from "../web/safe-fetch.js";

const MAX_RESPONSE_BYTES = 20_000_000;
const MAX_TUNNEL_BYTES = 50_000_000;
const MAX_CONNECTIONS = 8;
const MAX_HOST_CONNECTIONS = 2;

export interface BrowserNetworkProxyOptions {
  lookup?: typeof dnsLookup;
}

export class BrowserNetworkProxy {
  readonly #lookup: typeof dnsLookup;
  readonly #hostConnections = new Map<string, number>();
  readonly #tunnels = new Set<Duplex>();
  #activeConnections = 0;
  #server: HttpServer | null = null;

  constructor(options: BrowserNetworkProxyOptions = {}) {
    this.#lookup = options.lookup ?? dnsLookup;
  }

  async start(): Promise<string> {
    if (this.#server) return this.origin();
    const { createServer } = await import("node:http");
    const server = createServer((request, response) => {
      void this.#forwardHttp(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(502);
        response.end();
      });
    });
    server.on("connect", (request, client, head) => {
      void this.#forwardConnect(request.url ?? "", client, head).catch(() => {
        if (!client.destroyed) client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve);
    });
    this.#server = server;
    return this.origin();
  }

  origin(): string {
    const address = this.#server?.address();
    if (!address || typeof address === "string")
      throw new Error("Browser network proxy is not running.");
    return `http://127.0.0.1:${address.port}`;
  }

  async close(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    if (!server) return;
    for (const tunnel of this.#tunnels) tunnel.destroy();
    this.#tunnels.clear();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  async #forwardHttp(
    request: import("node:http").IncomingMessage,
    response: import("node:http").ServerResponse,
  ): Promise<void> {
    const target = normalizedPublicHttpUrl(request.url ?? "");
    if (target.protocol !== "http:") throw new Error("HTTPS requires CONNECT.");
    const release = await this.#acquire(target.hostname);
    try {
      const [selected] = await resolvePublicAddresses(
        target.hostname,
        this.#lookup,
      );
      const headers = { ...request.headers };
      delete headers["proxy-authorization"];
      delete headers.connection;
      headers.host = target.host;
      const upstream = httpRequest(target, {
        headers,
        lookup: (_hostname, options, callback) => {
          if (options.all) callback(null, [selected!]);
          else callback(null, selected!.address, selected!.family);
        },
        method: request.method,
        timeout: 30_000,
      });
      upstream.once("timeout", () => upstream.destroy(new Error("timeout")));
      upstream.once("error", () => {
        if (!response.headersSent) response.writeHead(502);
        response.end();
      });
      upstream.once("response", (incoming) => {
        response.writeHead(incoming.statusCode ?? 502, incoming.headers);
        let bytes = 0;
        incoming.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) {
            incoming.destroy();
            response.destroy();
          }
        });
        incoming.pipe(response);
      });
      request.pipe(upstream);
      await new Promise<void>((resolve) =>
        response.once("close", () => resolve()),
      );
    } finally {
      release();
    }
  }

  async #forwardConnect(
    authority: string,
    client: Duplex,
    head: Buffer,
  ): Promise<void> {
    const target = normalizedPublicHttpUrl(`https://${authority}`);
    const release = await this.#acquire(target.hostname);
    this.#tunnels.add(client);
    let upstream: Socket | null = null;
    try {
      const [selected] = await resolvePublicAddresses(
        target.hostname,
        this.#lookup,
      );
      upstream = netConnect({
        host: selected!.address,
        port: 443,
        family: selected!.family,
      });
      await new Promise<void>((resolve, reject) => {
        upstream!.once("connect", resolve);
        upstream!.once("error", reject);
        upstream!.setTimeout(30_000, () => reject(new Error("timeout")));
      });
      upstream.setTimeout(0);
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      let clientBytes = head.length;
      let serverBytes = 0;
      client.on("data", (chunk: Buffer) => {
        clientBytes += chunk.length;
        if (clientBytes > MAX_TUNNEL_BYTES) {
          client.destroy();
          upstream?.destroy();
        }
      });
      upstream.on("data", (chunk: Buffer) => {
        serverBytes += chunk.length;
        if (serverBytes > MAX_TUNNEL_BYTES) {
          client.destroy();
          upstream?.destroy();
        }
      });
      client.pipe(upstream);
      upstream.pipe(client);
      await new Promise<void>((resolve) =>
        client.once("close", () => resolve()),
      );
    } finally {
      this.#tunnels.delete(client);
      upstream?.destroy();
      release();
    }
  }

  async #acquire(hostname: string): Promise<() => void> {
    const hostCount = this.#hostConnections.get(hostname) ?? 0;
    if (
      this.#activeConnections >= MAX_CONNECTIONS ||
      hostCount >= MAX_HOST_CONNECTIONS
    )
      throw new Error("Browser network concurrency limit reached.");
    this.#activeConnections += 1;
    this.#hostConnections.set(hostname, hostCount + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#activeConnections -= 1;
      const next = (this.#hostConnections.get(hostname) ?? 1) - 1;
      if (next === 0) this.#hostConnections.delete(hostname);
      else this.#hostConnections.set(hostname, next);
    };
  }
}
