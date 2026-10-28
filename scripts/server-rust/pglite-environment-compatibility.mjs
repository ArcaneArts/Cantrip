// Real PGlite instances; verify boot effects, locale-dependent persistent hashes,
// SQL timezones and retained configuration independently of HTTP integration.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustExample } from "./build.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";

const at = process.argv.indexOf("--report");
const reportPath = at < 0 ? undefined : process.argv[at + 1];
const report = {
  suite: "actual-pglite-environment",
  completeReplacement: false,
  cases: [],
  cleanupFailures: [],
};
const executable = await buildRustExample("settings-repository-fixture");
const sql =
  "SELECT jsonb_build_object('timezone',current_setting('TimeZone'),'historical','1582-10-15T00:00:00Z'::timestamptz,'winter','2026-01-15T00:00:00Z'::timestamptz,'summer','2026-07-15T00:00:00Z'::timestamptz,'orderedNames',(SELECT jsonb_agg(label ORDER BY label) FROM (VALUES ('a'),('A'),('å'),('ä'),('z'),('Z'),('é'),('é'),('䎌'),('諼'),('1'),('10'),('2'),('__proto__')) names(label))) AS result";
const metadata = Object.fromEntries(
  [
    "a",
    "A",
    "å",
    "ä",
    "z",
    "Z",
    "Å",
    "é",
    "é",
    "䎌",
    "諼",
    "\uffff",
    "\ud800",
    "\udfff",
    "�",
  ].map((key, i) => [key, { value: i, password: "redacted" }]),
);
let failure;
try {
  for (const [timezone, locale] of [
    ["UTC", "en_US.UTF-8"],
    ["America/Chicago", "C.UTF-8"],
    ["Europe/Berlin", "de_DE.UTF-8"],
    ["Asia/Tokyo", "sv_SE.UTF-8"],
    ["Asia/Kathmandu", "da_DK.UTF-8"],
    ["Pacific/Apia", "ja_JP.UTF-8"],
    ["Australia/Lord_Howe", "en_US.UTF-8"],
    ["UTC", ""],
  ]) {
    const root = await mkdtemp(
      path.join(tmpdir(), "cantrip-pglite-environment-"),
    );
    const result = { timezone, locale, root, observations: [] };
    report.cases.push(result);
    let pair = [];
    const close = async () => {
      const results = await Promise.allSettled(
        pair.map((fixture) => fixture.close()),
      );
      pair = [];
      const errors = results
        .filter((entry) => entry.status === "rejected")
        .map((entry) => String(entry.reason));
      report.cleanupFailures.push(...errors);
      assert.equal(errors.length, 0, errors.join("\n"));
    };
    const open = async () => {
      for (const kind of ["node", "rust"])
        pair.push(
          await repositoryFixture({
            kind,
            executable,
            root,
            databaseMode: "pglite",
            nodeScript: "scripts/server-rust/settings-node-fixture.mjs",
          }),
        );
    };
    const compare = async (label, request) => {
      const expected = await pair[0].request(request),
        actual = await pair[1].request(request);
      result.observations.push({ label, request, expected, actual });
      assert.equal(
        expected.rejected,
        false,
        label + ": reference " + expected.diagnostic,
      );
      assert.equal(
        actual.rejected,
        false,
        label + ": native " + actual.diagnostic,
      );
      assert.deepEqual(actual.value, expected.value, label);
      return actual.value;
    };
    process.env.TZ = timezone;
    process.env.LC_ALL = process.env.LC_MESSAGES = process.env.LANG = locale;
    let phaseFailure;
    try {
      await open();
      const initial = await compare("actual initial database timezone", {
        op: "query-json",
        sql,
      });
      await compare("production metadata hash after database boot", {
        op: "catalog-hash",
        input: metadata,
      });
      await close();
      process.env.TZ = "UTC";
      await open();
      assert.deepEqual(
        await compare("retained timezone after host zone change", {
          op: "query-json",
          sql,
        }),
        initial,
      );
      await compare("retained metadata locale after database reopen", {
        op: "catalog-hash",
        input: metadata,
      });
      await compare("explicit database timezone configuration", {
        op: "sql",
        sql: "ALTER SYSTEM SET TimeZone='Asia/Kathmandu'",
      });
      await close();
      await open();
      const configured = await compare("explicit timezone survives restart", {
        op: "query-json",
        sql,
      });
      assert.equal(configured.timezone, "Asia/Kathmandu");
    } catch (error) {
      phaseFailure = error;
      result.failure = { message: error.message, stack: error.stack };
    } finally {
      try {
        await close();
      } catch (error) {
        phaseFailure = phaseFailure
          ? new AggregateError(
              [phaseFailure, error],
              "PGlite environment comparison and cleanup failed",
            )
          : error;
      }
    }
    if (phaseFailure) throw phaseFailure;
  }
} catch (error) {
  failure = error;
  report.failure = {
    message: error.message,
    stack: error.stack,
    causes: error.errors?.map((cause) => ({
      message: cause.message,
      stack: cause.stack,
    })),
  };
} finally {
  if (reportPath)
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
}
if (failure) throw failure;
console.log(
  JSON.stringify({
    cases: report.cases.length,
    comparisons: report.cases.reduce(
      (sum, entry) => sum + entry.observations.length,
      0,
    ),
    cleanupFailures: report.cleanupFailures.length,
  }),
);
