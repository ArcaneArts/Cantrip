// Real loopback HTTP and the production fetch/cache implementations. No
// provider credentials or external catalog traffic are used by this suite.
import assert from "node:assert/strict";
import http from "node:http";
import { gzipSync, deflateSync, brotliCompressSync } from "node:zlib";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustExample } from "./build.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { OpenRouterCatalogCache } from "../../cantrip_server/src/models/openrouter-catalog.ts";

const reportAt = process.argv.indexOf("--report");
const reportPath = reportAt < 0 ? null : process.argv[reportAt + 1];
const report = {
  suite: "actual-openrouter-public-http",
  completeReplacement: false,
  cases: [],
  failures: [],
};
const root = await mkdtemp(path.join(tmpdir(), "cantrip-openrouter-http-"));
const payload = JSON.stringify({
  data: [
    { id: " public/🦀 ", name: "Public", raw: { "\ud800": "original UTF16" } },
  ],
});
let behavior = {},
  requests = [];
const sockets = new Set();
const server = http.createServer((req, res) => {
  const current = behavior;
  requests.push({
    url: req.url,
    accept: req.headers.accept ?? null,
    etag: req.headers["if-none-match"] ?? null,
    authorization: req.headers.authorization ?? null,
  });
  if (current.networkError) {
    req.socket.destroy();
    return;
  }
  if (current.redirect && !req.url.startsWith("/redirected")) {
    res.writeHead(302, { location: "/redirected/catalog" });
    res.end();
    return;
  }
  if (current.redirectLoop) {
    res.writeHead(302, { location: req.url });
    res.end();
    return;
  }
  const send = () => {
    res.statusCode = current.status ?? 200;
    if (current.statusText !== undefined)
      res.statusMessage = current.statusText;
    res.setHeader("content-type", current.contentType ?? "application/json");
    if (current.etag !== undefined) res.setHeader("etag", current.etag);
    let body = Buffer.from(current.bytes ?? current.body ?? payload);
    if (current.compression) {
      body = { gzip: gzipSync, deflate: deflateSync, br: brotliCompressSync }[
        current.compression
      ](body);
      res.setHeader("content-encoding", current.compression);
    }
    if (current.truncated) {
      res.setHeader("content-length", body.length + 10);
      res.flushHeaders();
      res.write(body);
      setTimeout(() => res.destroy(), 10);
      return;
    }
    res.end(body);
  };
  if (current.headerDelay) {
    setTimeout(send, current.headerDelay).unref();
    return;
  }
  if (current.bodyDelay) {
    res.flushHeaders();
    setTimeout(() => res.end(payload), current.bodyDelay).unref();
    return;
  }
  send();
});
server.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let native;
try {
  native = await repositoryFixture({
    kind: "rust",
    databaseMode: "pglite",
    root,
    executable: await buildRustExample("openrouter-http-fixture"),
    requestTimeoutMs: 45000,
  });
  let now = 1000;
  const reference = new OpenRouterCatalogCache({ now: () => now, ttlMs: 100 });
  const cases = [
    { name: "valid Unicode and UTF16 payload", etag: '"v1"' },
    { name: "gzip public response", compression: "gzip" },
    { name: "deflate public response", compression: "deflate" },
    { name: "brotli public response", compression: "br" },
    { name: "UTF8 BOM", body: "\uFEFF" + payload },
    {
      name: "invalid UTF8 replaces bytes",
      bytes: Buffer.concat([
        Buffer.from('{"data":[{"id":"'),
        Buffer.from([0xe2, 0x82, 0x22]),
        Buffer.from("}]}"),
      ]),
    },
    {
      name: "charset ignored by JSON reader",
      contentType: "application/json; charset=iso-8859-1",
    },
    { name: "relative redirect", redirect: true },
    { name: "redirect limit", redirectLoop: true },
    {
      name: "custom status reason",
      status: 503,
      statusText: "Catalog Offline",
    },
    { name: "empty status reason", status: 503, statusText: "" },
    { name: "Latin1 status reason", status: 503, statusText: "Catalog \u00e9" },
    {
      name: "UTF8 status reason",
      status: 503,
      statusText: "Catalog \u00c3\u00a9",
    },
    {
      name: "duplicate ETag headers",
      etag: ['"first"', '"second"'],
      conditional: true,
    },
    {
      name: "cold 304 has no cached snapshot",
      status: 304,
      statusText: "Not Modified",
    },
    { name: "empty response JSON", status: 204 },
    { name: "invalid payload shape", body: '{"data":null}' },
    { name: "invalid JSON", body: '{"data":[}' },
    { name: "HTML error body", body: "<html>offline</html>" },
    { name: "truncated response body", truncated: true },
    { name: "disconnected HTTP server", networkError: true },
    { name: "URL credentials rejected before network", credentials: true },
    {
      name: "Latin1 ETag survives conditional refresh",
      etag: 'W/"\u00e9"',
      conditional: true,
    },
  ];
  if (process.argv.includes("--timeouts"))
    cases.push(
      { name: "actual 30-second header deadline", headerDelay: 31000 },
      { name: "actual 30-second body deadline", bodyDelay: 31000 },
    );
  for (let index = 0; index < cases.length; index++) {
    const test = cases[index];
    behavior = test;
    const key = `case:${index}`;
    const baseUrl = test.credentials
      ? origin.replace("http://", "http://user:password@") + "/api/v1"
      : `${origin}/case-${index}/api/v1///?discard=1#fragment`;
    const call = async (force = true) => {
      requests = [];
      let expected;
      try {
        const read = await reference.read({ baseUrl, cacheKey: key, force });
        expected = {
          snapshot: read.snapshot,
          servedStale: read.servedStale,
          background: !!read.backgroundRefresh,
        };
      } catch (error) {
        expected = { error: error.message };
      }
      const nodeRequests = requests;
      requests = [];
      const response = await native.request({
        op: "read",
        baseUrl,
        key,
        force,
        now,
      });
      assert.equal(response.rejected, false, response.diagnostic);
      const actual = response.value,
        rustRequests = requests;
      const row = {
        name: test.name,
        expected,
        actual,
        nodeRequests,
        rustRequests,
      };
      report.cases.push(row);
      try {
        assert.deepEqual(actual, expected, test.name);
        assert.deepEqual(
          rustRequests,
          nodeRequests,
          test.name + " public HTTP requests",
        );
      } catch (error) {
        report.failures.push(error.message);
      }
    };
    await call();
    if (test.conditional) {
      now += 1;
      behavior = { status: 304, etag: '"ignored"' };
      await call();
    }
  }
} finally {
  if (native) await native.close();
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
  if (reportPath) {
    await mkdir(path.dirname(path.resolve(reportPath)), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  }
}
assert.deepEqual(
  report.failures,
  [],
  "OpenRouter public HTTP compatibility failures",
);
console.log(
  JSON.stringify({
    suite: report.suite,
    cases: report.cases.length,
    completeReplacement: false,
    reportPath,
  }),
);
