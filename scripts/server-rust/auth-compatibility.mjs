// Actual Node/Rust socket comparisons. Fixture credentials never leave these
// disposable databases; the server executable does not invoke this oracle.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashPassword } from "../../cantrip_server/src/auth/service.ts";
import { buildRustServer, repositoryRoot } from "./build.mjs";
import { fixtureEnvironment, startServer } from "./process.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";

const executable =
  process.env.CANTRIP_RUST_SERVER_BINARY ?? (await buildRustServer());
const root = await mkdtemp(path.join(tmpdir(), "cantrip-auth-compatibility-"));
const origin = "http://127.0.0.1:5173";
const password = "isolated fixture password only";
const passwordHash = await hashPassword(password);
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const report = {
  schemaVersion: 1,
  suite: "authentication-http",
  completeReplacement: false,
  profiles: [],
};
const reportIndex = process.argv.indexOf("--report");
const reportPath = reportIndex < 0 ? undefined : process.argv[reportIndex + 1];
const databaseIndex = process.argv.indexOf("--database");
const databaseMode =
  databaseIndex < 0 ? "pglite" : process.argv[databaseIndex + 1];
assert.ok(["pglite", "bundled-postgres", "postgres"].includes(databaseMode));
report.databaseMode = databaseMode;
let postgresOwner;
const selected = process.argv.indexOf("--profile");
const versionRejection = process.argv.includes("--version-rejection");
const profiles = [
  { name: "none", mode: "none" },
  { name: "password", mode: "password" },
  { name: "accounts", mode: "accounts" },
  { name: "partitioned-password", mode: "password", secure: true },
  { name: "partitioned-accounts", mode: "accounts", secure: true },
  { name: "licensed-accounts", mode: "accounts", licensed: true },
  { name: "trusted-password", mode: "password", proxy: true },
  { name: "rate-limit", mode: "password", rate: 2 },
].filter((p) => selected < 0 || p.name === process.argv[selected + 1]);
assert.ok(profiles.length, "Unknown authentication profile");

function fixture(
  kind,
  profile,
  state = {
    clients: new Map(),
    ids: new Map(),
    tokens: new Map(),
    grants: new Map(),
    expirations: new Map(),
  },
) {
  const environment = fixtureEnvironment(path.join(root, profile.name, kind));
  Object.assign(environment, {
    CANTRIP_AUTH_MODE: profile.mode,
    CANTRIP_AUTH_RATE_LIMIT: String(profile.rate ?? 100),
    CANTRIP_LICENSE_WHITELIST_ENABLED: String(!!profile.licensed),
    CANTRIP_SESSION_TTL_SECONDS: "300",
    CANTRIP_API_BODY_LIMIT_BYTES: "65536",
  });
  if (profile.proxy) environment.CANTRIP_TRUSTED_PROXIES = "loopback";
  if (profile.mode !== "none") delete environment.CANTRIP_WORKER_TOKEN;
  if (profile.mode === "password")
    environment.CANTRIP_PASSWORD_HASH = passwordHash;
  if (profile.secure)
    Object.assign(environment, {
      CANTRIP_COOKIE_SECURE: "true",
      CANTRIP_COOKIE_SAME_SITE: "none",
    });
  if (profile.licensed)
    Object.assign(environment, {
      CANTRIP_ADMIN_EMAIL: "fixture@example.invalid",
      CANTRIP_ADMIN_PASSWORD: password,
    });
  const { clients, ids, tokens, grants, expirations } = state;
  function id(value) {
    if (value === "00000000-0000-0000-0000-000000000001") return value;
    assert.match(value, uuid);
    if (!ids.has(value)) ids.set(value, `<uuid:${ids.size}>`);
    return ids.get(value);
  }
  function token(value) {
    assert.match(value, /^[A-Za-z0-9_-]{43}$/);
    if (!tokens.has(value))
      tokens.set(value, {
        alias: `<session:${tokens.size}>`,
        csrf: createHash("sha256")
          .update(`cantrip-csrf:${value}`)
          .digest("hex"),
      });
    return tokens.get(value);
  }
  return {
    kind,
    profile,
    environment,
    server: undefined,
    clients,
    client(name = "main") {
      if (!clients.has(name)) clients.set(name, { cookies: new Map() });
      return clients.get(name);
    },
    async start() {
      this.server =
        kind === "node"
          ? await startServer(
              process.execPath,
              ["--import", "tsx", "scripts/server-rust/node-server.mjs"],
              { cwd: repositoryRoot, env: environment },
            )
          : await startServer(
              executable,
              [
                "--port",
                "0",
                "--database",
                databaseMode,
                "--shutdown-on-stdin-close",
              ],
              { cwd: repositoryRoot, env: environment },
            );
    },
    async close() {
      if (this.server) {
        const server = this.server;
        this.server = undefined;
        await server.close();
      }
    },
    async observe(label, method, url, options = {}) {
      const client = this.client(options.client);
      const extra =
        typeof options.headers === "function"
          ? options.headers(this, client)
          : options.headers;
      const json =
        typeof options.json === "function"
          ? options.json(this, client)
          : options.json;
      const headers = {
        origin,
        ...(json === undefined ? {} : { "content-type": "application/json" }),
        ...(client.cookies.size
          ? {
              cookie: [...client.cookies]
                .map(([k, v]) => `${k}=${v}`)
                .join("; "),
            }
          : {}),
        ...(options.csrf ? { "x-cantrip-csrf": client.csrf } : {}),
        ...extra,
      };
      const before = Date.now();
      const response = await fetch(this.server.origin + url, {
        method,
        headers,
        body:
          options.raw ??
          (json === undefined ? undefined : JSON.stringify(json)),
        signal: AbortSignal.timeout(15_000),
      });
      const text = await response.text();
      const body = text
        ? response.headers.get("content-type")?.includes("application/json")
          ? JSON.parse(text)
          : text
        : null;
      assert.equal(
        response.status,
        options.status ?? 200,
        `${profile.name}/${kind}: ${label}: ${text}`,
      );
      assert.match(
        response.headers.get("x-request-id"),
        uuid,
        `${label}: request ID`,
      );
      const normalizedCookies = response.headers
        .getSetCookie()
        .map((cookie) => {
          const [pair, ...attributes] = cookie.split("; ");
          const equals = pair.indexOf("=");
          const name = pair.slice(0, equals),
            value = pair.slice(equals + 1);
          if (value) client.cookies.set(name, value);
          else client.cookies.delete(name);
          return [
            `${name}=${value ? token(decodeURIComponent(value)).alias : ""}`,
            ...attributes,
          ].join("; ");
        });
      const normalized = structuredClone(body);
      if (body && typeof body === "object") {
        if (body.requestId) {
          assert.equal(body.requestId, response.headers.get("x-request-id"));
          normalized.requestId = "<request-id>";
        }
        if (body.currentUser) {
          client.userId = body.currentUser.id;
          normalized.currentUser.id =
            body.currentUser.id === "local-user"
              ? body.currentUser.id
              : id(body.currentUser.id);
        }
        if (body.server) {
          if (state.serverId)
            assert.equal(
              body.server.id,
              state.serverId,
              `${label}: retained server identity`,
            );
          else state.serverId = body.server.id;
          normalized.server.id = id(body.server.id);
          if (body.auth.currentUser)
            normalized.auth.currentUser.id = id(body.auth.currentUser.id);
        }
        if (body.csrfToken) {
          const entry = [...tokens.values()].find(
            (entry) => entry.csrf === body.csrfToken,
          );
          assert.ok(
            entry,
            `${label}: CSRF must derive from an issued session token`,
          );
          assert.match(body.csrfToken, /^[0-9a-f]{64}$/);
          client.csrf = body.csrfToken;
          normalized.csrfToken = entry.alias.replace("session", "csrf");
        }
        if (body.code && response.status === 201) {
          assert.match(body.code, /^ctms_[A-Za-z0-9_-]{32}$/);
          this.code = body.code;
          if (!grants.has(body.code))
            grants.set(body.code, `<grant:${grants.size}>`);
          normalized.code = grants.get(body.code);
        }
        if (body.expiresAt) {
          assert.match(
            body.expiresAt,
            /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/,
          );
          const expires = Date.parse(body.expiresAt),
            ttl = body.code ? 120_000 : 300_000;
          assert.ok(
            expires > before && expires <= Date.now() + ttl + 1000,
            `${label}: expiration range`,
          );
          if (normalized.csrfToken) {
            const key = normalized.csrfToken;
            if (expirations.has(key))
              assert.equal(
                body.expiresAt,
                expirations.get(key),
                `${label}: retained session expiry`,
              );
            else expirations.set(key, body.expiresAt);
            normalized.expiresAt = `<expiry:${key}>`;
          } else normalized.expiresAt = "<grant-expiry>";
        }
      }
      const names = [
        "content-type",
        "cache-control",
        "content-security-policy",
        "permissions-policy",
        "referrer-policy",
        "x-content-type-options",
        "x-frame-options",
        "x-permitted-cross-domain-policies",
        "strict-transport-security",
        "vary",
        "access-control-allow-origin",
        "access-control-allow-credentials",
        "access-control-allow-methods",
        "access-control-allow-headers",
        "retry-after",
      ];
      const observedHeaders = Object.fromEntries(
        names.map((name) => [name, response.headers.get(name)]),
      );
      if (observedHeaders["retry-after"] !== null) {
        assert.match(observedHeaders["retry-after"], /^\d+$/);
        assert.ok(
          +observedHeaders["retry-after"] >= 1 &&
            +observedHeaders["retry-after"] <= 60,
        );
        observedHeaders["retry-after"] = "<remaining-rate-window-seconds>";
      }
      return {
        status: response.status,
        headers: observedHeaders,
        setCookie: normalizedCookies,
        body: normalized,
      };
    },
  };
}

let failure;
try {
  if (databaseMode !== "pglite")
    postgresOwner = await postgresFixture(
      path.join(root, "reference-postgres"),
    );
  for (const profile of profiles) {
    const pair = [fixture("node", profile), fixture("rust", profile)];
    if (postgresOwner) {
      pair[0].environment.DATABASE_URL = await postgresOwner.database();
      if (databaseMode === "postgres")
        pair[1].environment.DATABASE_URL = await postgresOwner.database();
      else
        pair[1].environment.CANTRIP_POSTGRES_BIN_DIR =
          process.env.CANTRIP_TEST_POSTGRES_BIN_DIR;
    }
    const result = { name: profile.name, mode: profile.mode, cases: [] };
    report.profiles.push(result);
    async function visit(label, method, url, options) {
      const expected = await pair[0].observe(label, method, url, options);
      const actual = await pair[1].observe(label, method, url, options);
      assert.deepEqual(actual, expected, `${profile.name}: ${label}`);
      result.cases.push({ label, ...actual });
    }
    try {
      for (const server of pair) await server.start();
      if (versionRejection) {
        await visit("rejected synthetic version", "GET", "/version", {
          status: 500,
        });
        await visit("rejected synthetic bootstrap", "GET", "/api/bootstrap", {
          status: 500,
        });
        result.passed = true;
        continue;
      }
      await visit("version", "GET", "/version");
      await visit("bootstrap", "GET", "/api/bootstrap");
      await visit("empty session", "GET", "/api/auth/session");
      await visit("invalid preflight", "OPTIONS", "/api/auth/login", {
        status: 400,
      });
      await visit("preflight", "OPTIONS", "/api/auth/login", {
        headers: {
          "access-control-request-method": "POST",
          "access-control-request-headers": "Content-Type, X-Cantrip-CSRF",
        },
        status: 204,
      });
      await visit("rejected origin", "GET", "/api/auth/session", {
        headers: { origin: "https://rejected.example.invalid" },
        status: 403,
      });
      await visit("forwarding policy", "GET", "/api/auth/session", {
        headers: { "x-forwarded-for": "203.0.113.1" },
        status: profile.proxy ? 200 : 400,
      });
      if (profile.proxy) {
        for (const headers of [
          { forwarded: "for=203.0.113.1" },
          { "x-forwarded-for": "not-an-ip" },
          { "x-forwarded-for": "203.0.113.1, " },
          { "x-forwarded-for": Array(17).fill("203.0.113.1").join(",") },
          { "x-forwarded-proto": "https,http" },
          { "x-forwarded-host": "api.example.invalid,second.invalid" },
          { "x-forwarded-host": "a".repeat(256) },
        ])
          await visit(
            `invalid forwarding ${JSON.stringify(headers).slice(0, 80)}`,
            "GET",
            "/api/auth/session",
            { headers, status: 400 },
          );
        for (const headers of [
          { "x-forwarded-for": "2001:db8::1" },
          { "x-forwarded-for": "fe80::1%eth0" },
          { "x-forwarded-proto": "HTTPS" },
          {
            "x-forwarded-for": "203.0.113.1, 127.0.0.2",
            "x-forwarded-host": "api.example.invalid",
            "x-forwarded-proto": "https",
          },
        ])
          await visit(
            `valid forwarding ${JSON.stringify(headers)}`,
            "GET",
            "/api/auth/session",
            { headers },
          );
      }
      await visit("rejected login origin", "POST", "/api/auth/login", {
        json: { password },
        headers: { origin: "https://rejected.example.invalid" },
        status: 403,
      });
      for (const [label, raw, contentType, status] of [
        ["malformed JSON", "{", "application/json", 400],
        ["empty JSON", "", "application/json", 400],
        ["JSON poison key", '{"__proto__":{}}', "application/json", 400],
        ["unsupported type", "fixture", "application/x-fixture", 415],
        [
          "text body",
          "fixture",
          "text/plain",
          profile.mode === "none" ? 404 : 400,
        ],
        ["large body", "a".repeat(65537), "application/json", 413],
      ])
        await visit(label, "POST", "/api/auth/login", {
          raw,
          headers: { "content-type": contentType },
          status,
        });
      if (profile.rate) {
        for (let attempt = 0; attempt < 3; attempt++)
          await visit(
            `rate limit attempt ${attempt + 1}`,
            "POST",
            "/api/auth/login",
            {
              json: { password: "wrong password" },
              status: attempt < 2 ? 401 : 429,
            },
          );
        for (const server of pair) {
          await server.close();
          await server.start();
        }
        await visit("rate limit resets on restart", "POST", "/api/auth/login", {
          json: { password: "wrong password" },
          status: 401,
        });
        result.passed = true;
        continue;
      }
      if (profile.mode === "none") {
        for (const [url, body] of [
          [
            "register",
            {
              displayName: "Fixture",
              email: "fixture@example.invalid",
              password,
            },
          ],
          ["login", { password }],
          ["reauthenticate", { password }],
          ["mobile-sign-in/grants", undefined],
          ["mobile-sign-in/exchange", { code: `ctms_${"a".repeat(32)}` }],
        ])
          await visit(`unavailable ${url}`, "POST", `/api/auth/${url}`, {
            json: body,
            status: 404,
          });
        await visit("anonymous logout", "POST", "/api/auth/logout", {
          status: 204,
        });
        await visit("anonymous logout all", "POST", "/api/auth/logout-all");
        result.passed = true;
        continue;
      }
      await visit("overflow JSON number", "POST", "/api/auth/login", {
        raw: '{"password":1e999}',
        headers: { "content-type": "application/json" },
        status: 400,
      });
      await visit("unpaired UTF16 password", "POST", "/api/auth/login", {
        raw: '{"password":"\\ud800"}',
        headers: { "content-type": "application/json" },
        status: 401,
      });
      await visit("private authentication required", "GET", "/api/workers", {
        status: 401,
      });
      for (const body of [
        {},
        null,
        [],
        { password: [] },
        { email: "bad", password: "" },
        { password: "a".repeat(1025) },
      ])
        await visit(
          `invalid login ${JSON.stringify(body).slice(0, 60)}`,
          "POST",
          "/api/auth/login",
          { json: body, status: 400 },
        );
      await visit("incorrect password", "POST", "/api/auth/login", {
        json: { email: "fixture@example.invalid", password: "wrong password" },
        status: 401,
      });
      if (profile.mode === "accounts" && !profile.licensed) {
        await visit("first registration", "POST", "/api/auth/register", {
          json: {
            displayName: "  Fixture 🦀  ",
            email: "fixture@example.invalid",
            password,
            ignored: true,
          },
          status: 201,
        });
        await visit("duplicate registration", "POST", "/api/auth/register", {
          client: "duplicate",
          json: {
            displayName: "Duplicate",
            email: "FIXTURE@example.invalid",
            password,
          },
          status: 409,
        });
        await visit("member registration", "POST", "/api/auth/register", {
          client: "member",
          json: {
            displayName: "Member",
            email: "member@example.invalid",
            password,
          },
          status: 201,
        });
        await visit(
          "unpaired UTF16 display name storage",
          "POST",
          "/api/auth/register",
          {
            client: "unicode",
            raw: '{"displayName":"\\ud800","email":"unicode@example.invalid","password":"isolated fixture password only"}',
            headers: { "content-type": "application/json" },
            status: 201,
          },
        );
      } else {
        await visit("sign in", "POST", "/api/auth/login", {
          json: { email: "fixture@example.invalid", password },
        });
        if (profile.licensed)
          await visit("unlicensed registration", "POST", "/api/auth/register", {
            client: "member",
            json: {
              displayName: "Member",
              email: "member@example.invalid",
              password,
            },
            status: 403,
          });
      }
      await visit("authenticated session", "GET", "/api/auth/session");
      await visit("authenticated bootstrap", "GET", "/api/bootstrap");
      await visit(
        "reauthentication without CSRF",
        "POST",
        "/api/auth/reauthenticate",
        { json: { password }, status: 403 },
      );
      await visit(
        "strict reauthentication body",
        "POST",
        "/api/auth/reauthenticate",
        { csrf: true, json: { password, unknown: true }, status: 400 },
      );
      await visit(
        "incorrect reauthentication",
        "POST",
        "/api/auth/reauthenticate",
        { csrf: true, json: { password: "wrong password" }, status: 403 },
      );
      await visit("reauthentication", "POST", "/api/auth/reauthenticate", {
        csrf: true,
        json: { password },
      });
      await visit("account pin mismatch", "GET", "/api/auth/session", {
        client: "pin",
        headers: (f) => ({
          cookie: [...f.client().cookies]
            .map(([k, v]) => `${k}=${v}`)
            .join("; "),
          "x-cantrip-account-id": "wrong-account",
        }),
        status: 401,
      });
      await visit("matching account pin", "GET", "/api/auth/session", {
        headers: (_, client) => ({ "x-cantrip-account-id": client.userId }),
      });
      await visit("mobile grant", "POST", "/api/auth/mobile-sign-in/grants", {
        csrf: true,
        status: 201,
      });
      await visit(
        "mobile exchange",
        "POST",
        "/api/auth/mobile-sign-in/exchange",
        { client: "mobile", json: (f) => ({ code: f.code }) },
      );
      await visit(
        "mobile grant replay",
        "POST",
        "/api/auth/mobile-sign-in/exchange",
        { client: "mobile", json: (f) => ({ code: f.code }), status: 401 },
      );
      await visit("mobile session", "GET", "/api/auth/session", {
        client: "mobile",
      });
      await visit(
        "unknown mobile code",
        "POST",
        "/api/auth/mobile-sign-in/exchange",
        {
          client: "unknown",
          json: { code: `ctms_${"a".repeat(32)}` },
          status: 401,
        },
      );
      for (const server of pair) {
        await server.close();
        await server.start();
      }
      await visit("retained session after restart", "GET", "/api/auth/session");
      await visit("retained identity after restart", "GET", "/api/bootstrap");
      await visit("retained mobile session", "GET", "/api/auth/session", {
        client: "mobile",
      });
      if (profile.secure) {
        await visit("second sign in", "POST", "/api/auth/login", {
          client: "second",
          json: { email: "fixture@example.invalid", password },
        });
        await visit("conflicting session cookies", "GET", "/api/auth/session", {
          client: "conflict",
          headers: (f) => ({
            cookie: `__Host-cantrip_session=${f.client().cookies.get("__Host-cantrip_session")}; __Host-cantrip_partitioned_session=${f.client("second").cookies.get("__Host-cantrip_partitioned_session")}`,
          }),
          status: 401,
        });
        for (const server of pair) {
          await server.close();
          server.environment.CANTRIP_AUTH_MODE = "none";
          delete server.environment.CANTRIP_PASSWORD_HASH;
          await server.start();
        }
        await visit(
          "retained session in anonymous mode",
          "GET",
          "/api/auth/session",
        );
        await visit(
          "conflicting cookies in anonymous mode",
          "GET",
          "/api/auth/session",
          {
            client: "conflict",
            headers: (f) => ({
              cookie: `__Host-cantrip_session=${f.client().cookies.get("__Host-cantrip_session")}; __Host-cantrip_partitioned_session=${f.client("second").cookies.get("__Host-cantrip_partitioned_session")}`,
            }),
            status: 401,
          },
        );
        for (const server of pair) {
          await server.close();
          server.environment.CANTRIP_AUTH_MODE = profile.mode;
          if (profile.mode === "password")
            server.environment.CANTRIP_PASSWORD_HASH = passwordHash;
          await server.start();
        }
      }
      await visit("logout without CSRF", "POST", "/api/auth/logout", {
        status: 403,
      });
      await visit("logout incorrect CSRF", "POST", "/api/auth/logout", {
        headers: { "x-cantrip-csrf": "a".repeat(64) },
        status: 403,
      });
      await visit("logout mobile", "POST", "/api/auth/logout", {
        client: "mobile",
        csrf: true,
        status: 204,
      });
      await visit("session after logout", "GET", "/api/auth/session", {
        client: "mobile",
      });
      await visit(
        "creator revoked grant",
        "POST",
        "/api/auth/mobile-sign-in/grants",
        { csrf: true, status: 201 },
      );
      await visit("logout all", "POST", "/api/auth/logout-all", { csrf: true });
      await visit(
        "creator revocation blocks mobile exchange",
        "POST",
        "/api/auth/mobile-sign-in/exchange",
        { client: "unknown", json: (f) => ({ code: f.code }), status: 401 },
      );
      await visit("session after logout all", "GET", "/api/auth/session");
      if (profile.mode === "accounts" && !profile.licensed)
        await visit(
          "other owner session survives",
          "GET",
          "/api/auth/session",
          { client: "member" },
        );
      result.passed = true;
    } finally {
      const cleanup = await Promise.allSettled(
        pair.map((server) => server.close()),
      );
      const errors = cleanup
        .filter((r) => r.status === "rejected")
        .map((r) => r.reason);
      if (errors.length)
        throw new AggregateError(
          errors,
          "Authentication fixture cleanup failed",
        );
      console.log(
        JSON.stringify({
          profile: profile.name,
          cases: result.cases.length,
          passed: result.passed === true,
        }),
      );
    }
  }
  if (databaseMode === "postgres") {
    const profile = { name: "cross-runtime-retained-state", mode: "accounts" };
    const state = {
      clients: new Map(),
      ids: new Map(),
      tokens: new Map(),
      grants: new Map(),
      expirations: new Map(),
    };
    const node = fixture("node", profile, state),
      rust = fixture("rust", profile, state);
    const url = await postgresOwner.database();
    node.environment.DATABASE_URL = url;
    rust.environment.DATABASE_URL = url;
    const steps = [];
    async function observe(server, label, method, url, options) {
      const result = await server.observe(label, method, url, options);
      steps.push({ runtime: server.kind, label, ...result });
      return result;
    }
    try {
      await node.start();
      await observe(node, "Node creates owner", "POST", "/api/auth/register", {
        json: {
          displayName: "Retained Owner",
          email: "fixture@example.invalid",
          password,
        },
        status: 201,
      });
      const originalSession = await observe(
        node,
        "Node owner session",
        "GET",
        "/api/auth/session",
      );
      const originalBootstrap = await observe(
        node,
        "Node identity",
        "GET",
        "/api/bootstrap",
      );
      await node.close();
      await rust.start();
      assert.deepEqual(
        await observe(
          rust,
          "Rust reads Node session",
          "GET",
          "/api/auth/session",
        ),
        originalSession,
      );
      assert.deepEqual(
        await observe(
          rust,
          "Rust reads Node identity",
          "GET",
          "/api/bootstrap",
        ),
        originalBootstrap,
      );
      await observe(
        rust,
        "Rust verifies Node password",
        "POST",
        "/api/auth/reauthenticate",
        { csrf: true, json: { password } },
      );
      await observe(rust, "Rust creates member", "POST", "/api/auth/register", {
        client: "member",
        json: {
          displayName: "Rust Member",
          email: "member@example.invalid",
          password,
        },
        status: 201,
      });
      const memberSession = await observe(
        rust,
        "Rust member session",
        "GET",
        "/api/auth/session",
        { client: "member" },
      );
      await observe(
        rust,
        "Rust creates mobile code",
        "POST",
        "/api/auth/mobile-sign-in/grants",
        { csrf: true, status: 201 },
      );
      await observe(
        rust,
        "Rust exchanges mobile code",
        "POST",
        "/api/auth/mobile-sign-in/exchange",
        { client: "mobile", json: () => ({ code: rust.code }) },
      );
      const mobileSession = await observe(
        rust,
        "Rust mobile session",
        "GET",
        "/api/auth/session",
        { client: "mobile" },
      );
      await rust.close();
      await node.start();
      assert.deepEqual(
        await observe(
          node,
          "Node retains owner after Rust writes",
          "GET",
          "/api/auth/session",
        ),
        originalSession,
      );
      assert.deepEqual(
        await observe(
          node,
          "Node reads Rust member",
          "GET",
          "/api/auth/session",
          { client: "member" },
        ),
        memberSession,
      );
      assert.deepEqual(
        await observe(
          node,
          "Node reads Rust mobile session",
          "GET",
          "/api/auth/session",
          { client: "mobile" },
        ),
        mobileSession,
      );
      await observe(
        node,
        "Node verifies Rust password",
        "POST",
        "/api/auth/login",
        {
          client: "member-login",
          json: { email: "member@example.invalid", password },
        },
      );
      await node.close();
      await rust.start();
      await observe(
        rust,
        "Rust revokes retained owner sessions",
        "POST",
        "/api/auth/logout-all",
        { csrf: true },
      );
      await rust.close();
      await node.start();
      const revoked = await observe(
        node,
        "Node observes Rust revocation",
        "GET",
        "/api/auth/session",
        { client: "mobile" },
      );
      assert.equal(revoked.body.currentUser, null);
      report.crossRuntimeState = { passed: true, steps };
    } finally {
      const cleanup = await Promise.allSettled([node.close(), rust.close()]);
      const errors = cleanup
        .filter((r) => r.status === "rejected")
        .map((r) => r.reason);
      if (errors.length)
        throw new AggregateError(
          errors,
          "Cross-runtime fixture cleanup failed",
        );
    }
  }
} catch (error) {
  failure = error;
  report.failure = {
    message: error.message,
    actual: error.actual,
    expected: error.expected,
  };
} finally {
  await postgresOwner?.close();
  await rm(root, { recursive: true, force: true });
  if (reportPath) {
    await mkdir(path.dirname(path.resolve(reportPath)), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(
    JSON.stringify(
      {
        suite: report.suite,
        profiles: report.profiles.map((p) => ({
          name: p.name,
          cases: p.cases.length,
        })),
        failure: report.failure,
      },
      null,
      2,
    ),
  );
}
if (failure) throw failure;
