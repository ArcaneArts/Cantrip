// Actual production peers, actual PostgreSQL role rejection, and real probe
// results delayed at CommandComplete. No synthetic SQL error or result bodies.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { databaseHealthProxy } from "./database-health-proxy.mjs";
import { databaseOutageCases } from "./database-outage-cases.mjs";
const postgres = createRequire(
  new URL("../../tests/reference-node-server/package.json", import.meta.url),
)("postgres");

export async function databaseHealthCases(
  databaseUrl,
  {
    includeOutage = false,
    startupFailures = 0,
    startupConnectionLimit = 0,
  } = {},
) {
  const admin = postgres(databaseUrl, { max: 1 });
  const role = "health_" + randomUUID().replaceAll("-", "");
  const password = "privatehealth" + randomUUID().replaceAll("-", "");
  let proxy, startupRecovery;
  const errors = [],
    probes = [];
  const result = { slow: [], failed: [], recovered: null, startupFailures: [] };
  try {
    await admin.unsafe(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`);
    await admin.unsafe(
      `ALTER DATABASE "${new URL(databaseUrl).pathname.slice(1)}" OWNER TO "${role}"`,
    );
    const url = new URL(databaseUrl);
    url.username = role;
    url.password = password;
    if (startupFailures)
      await admin.unsafe(
        `ALTER ROLE "${role}" CONNECTION LIMIT ${startupConnectionLimit}`,
      );
    proxy = await databaseHealthProxy(url.href, {
      onError(error) {
        errors.push(error);
        if (
          error.code !== "53300" ||
          result.startupFailures.length >= startupFailures
        )
          return;
        result.startupFailures.push(error);
        if (result.startupFailures.length === startupFailures) {
          startupRecovery = restore();
          startupRecovery.catch((error) => {
            result.startupRecoveryError = error.message;
          });
        }
      },
      onProbe(probe) {
        probes.push(probe);
      },
    });
  } catch (error) {
    await admin.end({ timeout: 5 });
    throw error;
  }
  async function restore() {
    await admin.unsafe(`ALTER ROLE "${role}" CONNECTION LIMIT -1`);
  }
  return {
    url: proxy.url,
    result,
    async run(origin, cookie, waitForConsole) {
      if (startupFailures) {
        assert.equal(
          result.startupFailures.length,
          startupFailures,
          "Real PostgreSQL rejected every controlled startup connection",
        );
        await startupRecovery;
      }
      for (const route of ["/readyz", "/api/health"]) {
        const held = proxy.arm();
        let settled = false;
        const response = fetch(origin + route, {
          headers: { cookie, origin: "http://127.0.0.1:5173" },
          signal: AbortSignal.timeout(60000),
        }).finally(() => {
          settled = true;
        });
        response.catch(() => {});
        try {
          const witness = await Promise.race([
            held.observed,
            delay(5000).then(() => {
              throw new Error("No actual health SELECT 1 CommandComplete");
            }),
          ]);
          await delay(350);
          assert.equal(
            settled,
            false,
            "The real probe still awaits its actual acknowledgement",
          );
          held.release();
          const observed = await response;
          assert.equal(observed.status, 200);
          await observed.arrayBuffer();
          result.slow.push({ route, status: observed.status, witness });
        } finally {
          held.release();
        }
      }
      for (let index = 0; index < 6; index++) {
        const fault = proxy.arm(true);
        const response = await fetch(origin + "/readyz", {
          signal: AbortSignal.timeout(10000),
        });
        const body = await response.json();
        const witness = await fault.observed;
        assert.equal(response.status, 503);
        assert.equal(body.database.status, "unavailable");
        result.failed.push({
          status: response.status,
          database: body.database.status,
          witness,
        });
      }
      if (includeOutage)
        result.outage = await databaseOutageCases({
          origin,
          cookie,
          admin,
          role,
          errors,
          probes,
          waitForConsole,
          progress: (result.outage = {}),
        });
      const response = await fetch(origin + "/readyz", {
        signal: AbortSignal.timeout(60000),
      });
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(body.database.status, "ready");
      result.recovered = {
        status: response.status,
        database: body.database.status,
      };
    },
    verify(records) {
      let controlled = records;
      if (result.outage) {
        const boundary = records.findIndex(
          (record) =>
            record.context?.event === "http.request.completed" &&
            record.context.requestId === result.outage.boundary.requestId,
        );
        assert.ok(boundary >= 0, "Actual boundary completion is retained");
        controlled = records.slice(0, boundary);
        result.outage.diagnostics = records
          .slice(boundary)
          .filter((record) =>
            record.context?.event?.startsWith("database.health."),
          );
      }
      const health = controlled.filter((record) =>
        record.context?.event?.startsWith("database.health."),
      );
      assert.equal(
        health.filter(
          (record) => record.context.event === "database.health.slow",
        ).length,
        2,
      );
      assert.ok(
        health.some(
          (record) => record.context.event === "database.health.failed",
        ),
      );
      assert.ok(
        !JSON.stringify(records).includes(password),
        "Private database password is absent from persisted records",
      );
      return health.map((record) => {
        const copy = structuredClone(record);
        delete copy.timestamp;
        delete copy.cursor;
        delete copy.context.durationMs;
        return copy;
      });
    },
    async close() {
      try {
        await restore();
      } finally {
        await proxy.close();
        await admin.end({ timeout: 5 });
      }
    },
  };
}
