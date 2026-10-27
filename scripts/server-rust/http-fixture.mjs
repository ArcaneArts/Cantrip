// Disposable real-socket fixtures shared by security/domain compatibility suites.
// Normalize only values whose format and relationship are asserted below.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { repositoryRoot } from "./build.mjs";
import { fixtureEnvironment, startServer } from "./process.mjs";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const localId = "00000000-0000-0000-0000-000000000001";
const origin = "http://127.0.0.1:5173";
const comparedHeaders = [
  "content-type",
  "cache-control",
  "access-control-allow-origin",
  "access-control-allow-credentials",
  "vary",
  "x-content-type-options",
  "referrer-policy",
  "content-security-policy",
  "cross-origin-resource-policy",
  "cross-origin-opener-policy",
  "x-frame-options",
];

export class HttpFixture {
  constructor({
    kind,
    executable,
    root,
    name,
    databaseMode,
    environment = {},
    workerIngress = false,
  }) {
    Object.assign(this, {
      kind,
      executable,
      name,
      databaseMode,
      workerIngress,
    });
    this.environment = {
      ...fixtureEnvironment(path.join(root, name, kind)),
      CANTRIP_AUTH_RATE_LIMIT: "1000",
      CANTRIP_LICENSE_WHITELIST_ENABLED: "false",
      CANTRIP_SESSION_TTL_SECONDS: "300",
      CANTRIP_PAIRING_RATE_LIMIT_PER_MINUTE: "1000",
      ...environment,
    };
    if (this.environment.CANTRIP_AUTH_MODE !== "none")
      delete this.environment.CANTRIP_WORKER_TOKEN;
    this.clients = new Map();
    this.ids = new Map();
    this.tokens = new Map();
    this.requests = new Map();
    this.records = new Map();
    this.workerCredentials = new Map();
    this.workerCodes = new Map();
    this.enrollmentExpirations = new Set();
    this.enrollments = new Map();
  }
  client(name = "main") {
    if (!this.clients.has(name)) this.clients.set(name, { cookies: new Map() });
    return this.clients.get(name);
  }
  async start() {
    assert.equal(this.server, undefined);
    this.server =
      this.kind === "node"
        ? await startServer(
            process.execPath,
            [
              "--import",
              "tsx",
              "scripts/server-rust/node-server.mjs",
              ...(this.workerIngress ? ["--worker-ingress-fixture"] : []),
            ],
            { cwd: repositoryRoot, env: this.environment },
          )
        : await startServer(
            this.executable,
            [
              "--port",
              "0",
              "--database",
              this.databaseMode,
              "--shutdown-on-stdin-close",
            ],
            { cwd: repositoryRoot, env: this.environment },
          );
  }
  async close() {
    const server = this.server;
    this.server = undefined;
    try {
      await server?.close();
    } catch (error) {
      error.message = `${this.name}/${this.kind}: ${error.message}`;
      throw error;
    }
  }
  normalize(value, key = "") {
    if (Array.isArray(value)) return value.map((v) => this.normalize(v));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, this.normalize(v, k)]),
      );
    if (typeof value !== "string") return value;
    if (this.workerCredentials.has(value))
      return this.workerCredentials.get(value);
    if (this.workerCodes.has(value)) return this.workerCodes.get(value);
    if (key === "expiresAt" && this.enrollmentExpirations.has(value))
      return "<enrollment-code-expiry>";
    if (this.requests.has(value))
      return `<request:${this.requests.get(value)}>`;
    if (uuid.test(value)) {
      // Public fixture identities are stable and must survive unchanged.
      if (/^([1-9])\1{7}-/.test(value)) return value;
      if (!this.ids.has(value)) this.ids.set(value, `<uuid:${this.ids.size}>`);
      return this.ids.get(value);
    }
    if (value === localId) return value;
    if (/(?:At|Since)$/.test(key) && /^\d{4}-/.test(value)) {
      assert.match(value, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      assert.ok(
        Number.isFinite(Date.parse(value)),
        `Invalid timestamp: ${value}`,
      );
      assert.ok(
        Date.parse(value) <=
          Date.now() +
            (key === "expiresAt"
              ? Number(this.environment.CANTRIP_SESSION_TTL_SECONDS) * 1000 +
                1000
              : 1000),
        `Future timestamp: ${value}`,
      );
      // Static client-provided metadata is never a generated timestamp.
      return value === "2026-10-25T00:00:00.000Z" ? value : "<timestamp>";
    }
    return value;
  }
  async observe(label, method, url, options = {}) {
    const client = this.client(options.client);
    const input =
      typeof options.json === "function" ? options.json(this) : options.json;
    const target = typeof url === "function" ? url(this) : url;
    const extraHeaders =
      typeof options.headers === "function"
        ? options.headers(this)
        : options.headers;
    const headers = {
      ...(options.noOrigin || options.client === "worker" ? {} : { origin }),
      ...(input === undefined ? {} : { "content-type": "application/json" }),
      ...(client.cookies.size
        ? {
            cookie: [...client.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
          }
        : {}),
      ...(options.csrf ? { "x-cantrip-csrf": client.csrf } : {}),
      ...extraHeaders,
    };
    const startedAt = Date.now();
    const response = await fetch(this.server.origin + target, {
      method,
      headers,
      body:
        options.raw ??
        (input === undefined ? undefined : JSON.stringify(input)),
      signal: AbortSignal.timeout(15000),
    });
    const text = await response.text();
    const body = text ? JSON.parse(text) : null;
    assert.equal(
      response.status,
      options.status ?? 200,
      `${this.name}/${this.kind}/${label}: ${text}`,
    );
    const requestId = response.headers.get("x-request-id");
    assert.match(requestId, uuid);
    this.requests.set(requestId, label);
    if (body?.code?.startsWith("ctwl_")) {
      assert.match(body.code, /^ctwl_[A-Za-z0-9_-]{32}$/);
      assert.equal(Buffer.from(body.code.slice(5), "base64url").length, 24);
      assert.equal(
        this.workerCodes.has(body.code),
        false,
        "Enrollment codes must be unique across generated responses",
      );
      this.workerCodes.set(body.code, `<worker-code:${this.workerCodes.size}>`);
      const ttl = (input?.expiresInSeconds ?? 600) * 1000;
      assert.ok(
        Date.parse(body.expiresAt) > startedAt &&
          Date.parse(body.expiresAt) <= Date.now() + ttl + 1000,
        "Worker enrollment TTL",
      );
      this.enrollmentExpirations.add(body.expiresAt);
      this.enrollments.set(body.id, body.expiresAt);
    }
    if (body?.status && this.enrollments.has(body.id))
      assert.equal(
        body.expiresAt,
        this.enrollments.get(body.id),
        "Retained enrollment expiry",
      );
    if (body?.credential) {
      assert.match(body.credential, /^ctwk_[A-Za-z0-9_-]{43}$/);
      const bytes = Buffer.from(body.credential.slice(5), "base64url");
      assert.equal(bytes.length, 32);
      assert.equal(bytes.toString("base64url"), body.credential.slice(5));
      assert.equal(
        this.workerCredentials.has(body.credential),
        false,
        "Rotated and enrolled secrets must be unique",
      );
      this.workerCredentials.set(
        body.credential,
        `<worker-credential:${this.workerCredentials.size}>`,
      );
    }
    if (body?.requestId) assert.equal(body.requestId, requestId);
    const setCookie = response.headers.getSetCookie().map((cookie) => {
      const [pair, ...attributes] = cookie.split("; "),
        equals = pair.indexOf("="),
        name = pair.slice(0, equals),
        value = pair.slice(equals + 1);
      if (value) client.cookies.set(name, value);
      else client.cookies.delete(name);
      let alias = "";
      if (value) {
        const token = decodeURIComponent(value);
        assert.match(token, /^[A-Za-z0-9_-]{43}$/);
        if (!this.tokens.has(token))
          this.tokens.set(token, `<session:${this.tokens.size}>`);
        alias = this.tokens.get(token);
      }
      return [`${name}=${alias}`, ...attributes].join("; ");
    });
    if (body?.csrfToken) {
      const token = [...client.cookies.values()]
        .map((v) => decodeURIComponent(v))
        .find(
          (v) =>
            createHash("sha256").update(`cantrip-csrf:${v}`).digest("hex") ===
            body.csrfToken,
        );
      assert.ok(token, "CSRF must derive from the issued session token");
      client.csrf = body.csrfToken;
    }
    const normalized = this.normalize(body);
    if (body?.csrfToken)
      normalized.csrfToken = this.tokens
        .get(
          [...client.cookies.values()]
            .map(decodeURIComponent)
            .find(
              (v) =>
                createHash("sha256")
                  .update(`cantrip-csrf:${v}`)
                  .digest("hex") === body.csrfToken,
            ),
        )
        .replace("session", "csrf");
    this.records.set(label, body);
    return {
      status: response.status,
      headers: Object.fromEntries(
        comparedHeaders.map((name) => [name, response.headers.get(name)]),
      ),
      setCookie,
      body: normalized,
    };
  }
}
