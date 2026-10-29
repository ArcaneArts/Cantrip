// Real HTTP/1 upgrade bytes, including malformed headers that ws clients reject
// locally. Each implementation receives the same request on its own database.
import assert from "node:assert/strict";
import { connect } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustServer } from "./build.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";

const option = (name) => {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
};
const databaseMode = option("--database") ?? "pglite";
const reportPath = option("--report");
const root = await mkdtemp(path.join(tmpdir(), "cantrip-tunnel-handshake-"));
const key = "dGhlIHNhbXBsZSBub25jZQ==";
const cases = [
  { name: "valid GET" },
  { name: "valid GET without close", connection: "Upgrade" },
  { name: "automatic HEAD", method: "HEAD" },
  {
    name: "automatic HEAD without close",
    method: "HEAD",
    connection: "Upgrade",
  },
  { name: "ordinary HTTP close", ordinary: true },
  { name: "invalid upgrade", upgrade: "not-websocket" },
  { name: "missing key", key: null },
  { name: "empty key", key: "" },
  { name: "short key", key: "a==" },
  { name: "invalid key alphabet", key: "!".repeat(22) + "==" },
  { name: "invalid key padding", key: "a".repeat(24) },
  { name: "duplicate key", extra: [`Sec-WebSocket-Key: ${key}`] },
  { name: "version 8", version: "8" },
  { name: "hex version", version: "0xd" },
  { name: "exponent version", version: "1.3e1" },
  { name: "missing version", version: null },
  { name: "invalid version", version: "12" },
  { name: "duplicate version", extra: ["Sec-WebSocket-Version: 13"] },
  {
    name: "protocol selection",
    protocol: "cantrip-tunnel-v1.fixture, secondary",
  },
  {
    name: "protocol whitespace",
    protocol: "cantrip-tunnel-v1.fixture ,\tsecondary",
  },
  { name: "duplicate protocol", protocol: "fixture, fixture" },
  { name: "empty protocol", protocol: "" },
  { name: "trailing protocol comma", protocol: "fixture," },
  { name: "invalid protocol token", protocol: "fixture/invalid" },
];
function request(origin, input) {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(url.port), url.hostname);
    const chunks = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Actual upgrade timed out: ${input.name}`));
    }, 15_000);
    socket.once("error", reject);
    socket.once("connect", () => {
      const headers = [
        `${input.method ?? "GET"} ${input.ordinary ? "/api" : "/api/tunnel-attachments/00000000-0000-4000-8000-000000000099/connect"} HTTP/1.1`,
        `Host: ${url.host}`,
        ...(input.ordinary ? [] : [`Upgrade: ${input.upgrade ?? "websocket"}`]),
        `Connection: ${input.connection ?? (input.ordinary ? "close" : "Upgrade, close")}`,
        ...(input.key === null
          ? []
          : [`Sec-WebSocket-Key: ${input.key ?? key}`]),
        ...(input.version === null
          ? []
          : [`Sec-WebSocket-Version: ${input.version ?? "13"}`]),
        ...(input.protocol === undefined
          ? []
          : [`Sec-WebSocket-Protocol: ${input.protocol}`]),
        ...(input.extra ?? []),
      ];
      socket.write(headers.join("\r\n") + "\r\n\r\n");
    });
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      if (
        Buffer.concat(chunks).includes(Buffer.from("\r\n\r\n")) &&
        Buffer.concat(chunks).toString().startsWith("HTTP/1.1 101")
      )
        socket.destroy();
    });
    socket.once("close", () => {
      clearTimeout(timer);
      const bytes = Buffer.concat(chunks),
        separator = bytes.indexOf("\r\n\r\n");
      if (separator < 0) {
        reject(new Error(`No HTTP response for ${input.name}`));
        return;
      }
      const [statusLine, ...lines] = bytes
        .subarray(0, separator)
        .toString("latin1")
        .split("\r\n");
      const headers = Object.fromEntries(
        lines.map((line) => {
          const at = line.indexOf(":");
          return [line.slice(0, at).toLowerCase(), line.slice(at + 1).trim()];
        }),
      );
      // Date and per-request identity vary; retain actual framing and all raw
      // headers in the report, and compare the upgrade contract explicitly.
      resolve({
        name: input.name,
        status: Number(statusLine.split(" ")[1]),
        headers,
        body: bytes.subarray(separator + 4).toString("utf8"),
      });
    });
  });
}
const report = {
  suite: "actual-legacy-tunnel-handshakes",
  databaseMode,
  completeReplacement: false,
  profiles: [],
};
let postgres, failure;
try {
  const executable = await buildRustServer();
  if (databaseMode !== "pglite")
    postgres = await postgresFixture(path.join(root, "postgres"));
  for (const profile of ["none", "accounts"]) {
    const runtimes = [];
    report.profiles.push({ profile, runtimes });
    for (const kind of ["node", "rust"]) {
      const databaseUrl =
        postgres && (kind === "node" || databaseMode === "postgres")
          ? await postgres.database()
          : undefined;
      const fixture = new HttpFixture({
        kind,
        executable,
        root,
        name: profile,
        databaseMode,
        environment: {
          CANTRIP_AUTH_MODE: profile,
          ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}),
          ...(kind === "rust" && databaseMode === "bundled-postgres"
            ? {
                CANTRIP_POSTGRES_BIN_DIR:
                  process.env.CANTRIP_TEST_POSTGRES_BIN_DIR,
              }
            : {}),
        },
      });
      const observations = [];
      runtimes.push({ kind, observations });
      try {
        await fixture.start();
        for (const input of cases)
          observations.push(await request(fixture.server.origin, input));
      } finally {
        runtimes.at(-1).diagnostics = fixture.server?.diagnostics();
        await fixture.close();
      }
    }
    const comparable = (runtime) =>
      runtime.observations.map(({ name, status, headers, body }) => ({
        name,
        status,
        body: status === 101 ? "" : body,
        headers: Object.fromEntries(
          Object.entries(headers).map(([name, value]) => {
            if (name === "date") {
              assert.ok(Number.isFinite(Date.parse(value)), "actual HTTP date");
              return [name, "<date>"];
            }
            if (name === "x-request-id") {
              assert.match(
                value,
                /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
              );
              return [name, "<request-id>"];
            }
            return [name, value];
          }),
        ),
      }));
    assert.equal(runtimes[0].observations[0].status, 101);
    assert.deepEqual(
      comparable(runtimes[1]),
      comparable(runtimes[0]),
      `${profile} actual raw upgrade behavior`,
    );
  }
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  await postgres?.close();
  if (reportPath)
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  if (!failure) await rm(root, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(
  JSON.stringify({
    suite: report.suite,
    databaseMode,
    profiles: report.profiles.map(({ profile, runtimes }) => ({
      profile,
      runtimes: runtimes.map(({ kind, observations }) => ({
        kind,
        requests: observations.length,
      })),
    })),
  }),
);
