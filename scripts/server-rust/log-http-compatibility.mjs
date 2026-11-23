import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { fixtureEnvironment, startServer } from "./process.mjs";
import { repositoryRoot } from "./build.mjs";
const { values } = parseArgs({
  options: { binary: { type: "string" }, report: { type: "string" } },
});
const root = await mkdtemp(path.join(tmpdir(), "cantrip-http-logs-"));
console.error(JSON.stringify({ event: "http-logs.created", root }));
const report = { root, peers: [] };
let failure;
try {
  for (const kind of ["node", "rust"]) {
    const data = path.join(root, kind);
    await mkdir(data);
    const server = await startServer(
      kind === "node" ? process.execPath : values.binary,
      kind === "node"
        ? [
            "--import",
            "tsx",
            "scripts/server-rust/log-http-node-fixture.mjs",
            "--data-dir",
            data,
          ]
        : ["--data-dir", data],
      {
        cwd: repositoryRoot,
        env: {
          ...fixtureEnvironment(data),
          CANTRIP_LOG_LEVEL: "trace",
          NO_COLOR: "1",
        },
      },
    );
    const base = server.origin + "/api/log-test";
    const peer = { kind, stdout: "", stderr: "", responses: [] };
    report.peers.push(peer);
    server.child.stdout.on("data", (chunk) => {
      peer.stdout += chunk;
    });
    server.child.stderr.on("data", (chunk) => {
      peer.stderr += chunk;
    });
    async function seen(fragment) {
      const deadline = Date.now() + 10000;
      while (!(peer.stdout + peer.stderr).includes(fragment)) {
        assert.ok(Date.now() < deadline, "Actual console record: " + fragment);
        await delay(10);
      }
    }
    try {
      for (const route of [
        "/finite/normal?token=private-query-marker",
        "/empty",
        "/status/404",
        "/status/500",
      ]) {
        const response = await fetch(base + route);
        peer.responses.push({
          route,
          status: response.status,
          body: await response.text(),
        });
      }
      const head = await fetch(base + "/finite/head", { method: "HEAD" });
      assert.equal(await head.text(), "");
      for (const [mode, id] of [
        ["slow", "held"],
        ["slow", "abandoned"],
        ["failed", "errored"],
      ]) {
        const controller = new AbortController();
        const response = await fetch(base + `/${mode}/${id}`, {
          signal: controller.signal,
        });
        const reader = response.body.getReader();
        assert.equal(
          Buffer.from((await reader.read()).value).toString(),
          "first\n",
        );
        const control = await fetch(base + `/finite/control-${id}`);
        await control.text();
        await seen(`GET /api/log-test/finite/control-${id} -> 200 OK`);
        assert.ok(
          !(peer.stdout + peer.stderr).includes(
            `GET /api/log-test/${mode}/${id} ->`,
          ),
          "Response headers/first chunk do not complete the request",
        );
        if (id === "abandoned") {
          controller.abort();
          await reader.cancel().catch(() => {});
          await delay(100);
        }
        await writeFile(path.join(data, id), "release");
        if (id === "held") {
          assert.equal(
            Buffer.from((await reader.read()).value).toString(),
            "last\n",
          );
          assert.equal((await reader.read()).done, true);
          await seen("GET /api/log-test/slow/held -> 200 OK");
        }
        if (id === "errored") {
          await reader.read().catch(() => {});
          await delay(100);
        }
      }
      for (const level of [
        "trace",
        "debug",
        "info",
        "warn",
        "error",
        "fatal",
        "silent",
      ]) {
        for (const method of ["GET", "HEAD"])
          for (const code of [200, 404, 500]) {
            const route = `/level/${level}/status/${code}`;
            const response = await fetch(base + route, { method });
            const body = await response.text();
            assert.equal(response.status, code);
            assert.equal(body, method === "HEAD" ? "" : "status");
            peer.responses.push({
              method,
              route,
              status: response.status,
              body,
            });
          }
        const id = `level-${level}`;
        const response = await fetch(base + `/level/${level}/failed/${id}`);
        const reader = response.body.getReader();
        assert.equal(
          Buffer.from((await reader.read()).value).toString(),
          "first\n",
        );
        const control = await fetch(base + `/finite/control-${id}`);
        await control.text();
        await seen(`GET /api/log-test/finite/control-${id} -> 200 OK`);
        await writeFile(path.join(data, id), "release");
        await reader.read().catch(() => {});
        // Observe the closed socket before advancing, preserving producer order.
        await delay(100);
      }
    } finally {
      await server.close();
      peer.exit = {
        code: server.child.exitCode,
        signal: server.child.signalCode,
      };
    }
    peer.records = [];
    for (const name of await readdir(path.join(data, "logs")))
      if (name.endsWith(".jsonl"))
        peer.records.push(
          ...(await readFile(path.join(data, "logs", name), "utf8"))
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line)),
        );
    peer.http = peer.records
      .filter((r) => r.context?.event === "http.request.completed")
      .map((r) => {
        const result = structuredClone(r);
        delete result.timestamp;
        delete result.cursor;
        delete result.context.requestId;
        delete result.context.durationMs;
        return result;
      });
    peer.streamErrors = peer.records
      .filter(
        (r) =>
          r.level === "warn" &&
          r.message === "server.diagnostic" &&
          r.context?.reqId,
      )
      .map((r) => {
        const result = structuredClone(r);
        delete result.timestamp;
        delete result.cursor;
        delete result.context.reqId;
        return result;
      });
    assert.equal(
      peer.streamErrors.length,
      5,
      "Default plus trace/debug/info/warn streams capture warnings; error/fatal/silent suppress them",
    );
    assert.ok(
      peer.stderr.includes(
        "WARN response terminated with an error with headers already sent · error=controlled-private-stream-body",
      ),
    );
    assert.ok(!JSON.stringify(peer.records).includes("private-query-marker"));
    assert.ok(
      !JSON.stringify(peer.records).includes("controlled-private-stream-body"),
    );
  }
  assert.deepEqual(
    report.peers[1].responses,
    report.peers[0].responses,
    "Route levels preserve actual response status and body",
  );
  assert.deepEqual(
    report.peers[1].http,
    report.peers[0].http,
    "Actual HTTP completion/abandon/error behavior matches Source",
  );
  assert.deepEqual(
    report.peers[1].streamErrors,
    report.peers[0].streamErrors,
    "Failed stream diagnostics preserve the same archive minimization",
  );
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  if (values.report)
    await writeFile(values.report, JSON.stringify(report, null, 2) + "\n");
}
if (failure) throw failure;
console.log(
  JSON.stringify({
    passed: true,
    root,
    records: report.peers.map((p) => p.http.length),
  }),
);
