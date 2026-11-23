// Production routers, actual worker socket, native session and HTTP SDK.
// Native resume results and the Goal runtime mutation are controlled.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashPassword } from "../../tests/reference-node-server/src/auth/service.ts";
import { buildRustExample } from "./build.mjs";
import {
  settingsChat,
  settingsHttpFixture,
} from "./native-settings-http-fixture.mjs";
import { LiveProbe } from "./live-sockets.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { password } from "./security-fixtures.mjs";
import {
  automationResumeHttpCases,
  resumeSql,
} from "./automation-resume-http-cases.mjs";

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

const databaseMode = option("--database") ?? "pglite";
const profiles = ["none", "password", "accounts"];
const selected = option("--profile");
assert.ok(["pglite", "bundled-postgres", "postgres"].includes(databaseMode));
assert.ok(!selected || profiles.includes(selected));
const root = await mkdtemp(
  path.join(tmpdir(), "cantrip-automation-resume-http-"),
);
const report = {
  suite: "automation-resume-http",
  databaseMode,
  root,
  profiles: [],
  completeReplacement: false,
};
let pg, failure;
try {
  const executable =
    process.env.CANTRIP_RUST_HTTP_FIXTURE_BINARY ??
    (await buildRustExample("http-sql-fixture"));
  const passwordHash = await hashPassword(password);
  if (databaseMode !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const profile of profiles.filter(
    (name) => !selected || selected === name,
  )) {
    const outputs = [];
    report.profiles.push({ profile, outputs });
    for (const kind of ["node", "rust"]) {
      const result = {
        kind,
        startedAt: Date.now(),
        observations: [],
        snapshotProofs: 0,
        commands: [],
        states: {},
        sdk: [],
        workerErrors: [],
      };
      outputs.push(result);
      const url =
        pg && (kind === "node" || databaseMode === "postgres")
          ? await pg.database()
          : undefined;
      const cases = automationResumeHttpCases(result, root);
      const h = await settingsHttpFixture({
        kind,
        profile,
        root,
        executable,
        databaseMode,
        url,
        passwordHash,
        result,
        configure: cases.configure,
        onCommand: cases.onCommand,
        liveSqlFixture: true,
        environment: { CANTRIP_FIXTURE_LOGGING: "true" },
      });
      let foreignLive;
      try {
        if (profile === "accounts") {
          foreignLive = await new LiveProbe(h.fixture, {
            client: "other",
          }).open();
          await foreignLive.initialized();
          await foreignLive.subscribed("foreign-current-user");
        }
        await cases.run(h, profile);
        if (foreignLive) {
          await foreignLive.ping("foreign user observes no Chat invalidation");
          result.foreignLive = foreignLive.history.filter(
            (event) => event.type === "event" && event.resource === "chat",
          );
          assert.deepEqual(result.foreignLive, []);
          await foreignLive.close();
          foreignLive = undefined;
        }
        const origin = h.fixture.server.origin;
        result.diagnostics = h.diagnostics();
        await h.close();
        await h.fixture.start({ port: Number(new URL(origin).port) });
        assert.equal(h.fixture.server.origin, origin);
        result.reopened = (await h.fixture.sql([], [resumeSql]))[0];
        const nextDelivery = Date.parse(
          result.reopened.queue.notification_due_at,
        );
        assert.ok(
          nextDelivery >=
            Date.parse(result.states.final.queue.notification_due_at),
        );
        assert.ok(nextDelivery <= Date.now() + 5500);
        assert.deepEqual(result.reopened, {
          ...result.states.final,
          queue: {
            ...result.states.final.queue,
            notification_due_at: result.reopened.queue.notification_due_at,
          },
        });
        for (const resource of ["queue", "messages"]) {
          const previous = h.fixture.records.get(
            resource === "queue"
              ? "final managed queue"
              : "final protected history",
          );
          const reopened = await h.visit(
            "reopened " + resource,
            "GET",
            `/api/chats/${settingsChat}/${resource}`,
          );
          assert.deepEqual(reopened, previous);
        }
        cases.finish();
      } finally {
        cases.release();
        await foreignLive?.close();
        result.rawHttp = Object.fromEntries(h.fixture.records);
        result.finalDiagnostics = h.diagnostics();
        await h.close();
      }
      console.log(
        JSON.stringify({
          profile,
          kind,
          http: result.comparison.http.length,
          sdk: result.sdk.length,
          commands: result.commands.length,
          events: result.live.flat().length,
          retainedRestarts: 1,
        }),
      );
    }
    for (const key of Object.keys(outputs[0].comparison)) {
      assert.deepEqual(
        outputs[1].comparison[key],
        outputs[0].comparison[key],
        `${profile} ${key} differs between the production routers`,
      );
    }
  }
  report.passed = true;
} catch (error) {
  failure = error;
  report.error = String(error.stack ?? error);
  console.error(error);
} finally {
  await pg?.close();
  if (option("--report"))
    await writeFile(option("--report"), JSON.stringify(report, null, 2) + "\n");
  if (!process.argv.includes("--keep-fixture"))
    await rm(root, { recursive: true, force: true });
}
if (failure) process.exitCode = 1;
