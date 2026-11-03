import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { settingsHttpFixture } from "./native-settings-http-fixture.mjs";
import { heartbeat, password } from "./security-fixtures.mjs";
import { buildRustServer, buildRustExample } from "./build.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { hashPassword } from "../../cantrip_server/src/auth/service.ts";
import {
  retentionControls,
  foreignOwnerControl,
  durabilitySnapshot,
  productionBodyChecks,
} from "./chat-archive-cleanup-controls.mjs";
const option = (key) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite";
const root = await mkdtemp(
  path.join(tmpdir(), "cantrip-archive-cleanup-http-"),
);
const route = "/api/chats/archives/cleanup";
const literal = (s) => "'" + s.replaceAll("'", "''") + "'";
const date = (s) => (s === null ? "NULL" : literal(s) + "::timestamptz");
const id = (n) => `88888888-8888-4888-8888-${String(n).padStart(12, "0")}`;
const report = {
  suite: "chat-archive-cleanup-http",
  databaseMode,
  profiles: [],
  completeReplacement: false,
  root,
};
let pg, failure;
async function until(read, check) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = await read();
    if (check(value)) return value;
    assert.ok(Date.now() < deadline, JSON.stringify(value));
    await delay(10);
  }
}
try {
  // Keep production and disposable control executables distinct. All feature
  // requests still execute the actual production router, repositories and jobs.
  const server = await buildRustServer();
  const sqlExample = await buildRustExample("http-sql-fixture");
  const passwordHash = await hashPassword(password);
  if (databaseMode !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  report.productionExecutable = server;
  for (const profile of option("--profile")
    ? [option("--profile")]
    : ["none", "password", "accounts"]) {
    const runtimes = [];
    report.profiles.push({ profile, runtimes });
    for (const kind of ["node", "rust"]) {
      const result = {
        kind,
        observations: [],
        commands: [],
        invalidations: [],
      };
      runtimes.push(result);
      let h;
      try {
        const url =
          pg && (kind === "node" || databaseMode === "postgres")
            ? await pg.database()
            : undefined;
        h = await settingsHttpFixture({
          kind,
          profile,
          root,
          executable: sqlExample,
          databaseMode,
          url,
          passwordHash,
          result,
          liveSqlFixture: true,
          onCommand: async (command) => {
            if (command.type !== "chat.scratch.delete") return undefined;
            result.commands.push(command);
            return {
              rootId: command.rootId,
              chatId: command.chatId,
              jobId: command.jobId,
              attempt: command.attempt,
              deleted: true,
            };
          },
        });
        await h.live.subscribed("archive-owner", [{ kind: "current-user" }]);
        await h.visit(
          "enable scratch deletion",
          "POST",
          "/api/internal/workers/heartbeat",
          {
            client: "worker",
            status: 202,
            headers: { authorization: "Bearer " + h.credential },
            json: {
              ...heartbeat,
              workerId: h.scope.workerId,
              standaloneChat: {
                protocolVersion: 1,
                scratch: { ...heartbeat.standaloneChat.scratch, remove: true },
                files: heartbeat.standaloneChat.files,
              },
            },
          },
        );
        const projectChat = id(1),
          standalone = id(2),
          scratch = id(3);
        const projectSeed = (chat, archived = "2000-01-01T00:00:00Z") =>
          `INSERT INTO chats(id,owner_id,project_id,active_worktree_id,active_worker_id,protected_label,experience,archived_at) SELECT ${literal(chat)},owner_id,project_id,active_worktree_id,active_worker_id,protected_label,'agent',${date(archived)} FROM chats WHERE id=${literal(h.scope.chatId)}`;
        const scratchSeed = (
          chat,
          rootId,
          archived = "2000-01-01T00:00:00Z",
          expires = "2001-01-01T00:00:00Z",
          owner = h.owner,
          worker = h.scope.workerId,
        ) => [
          `INSERT INTO chats(id,owner_id,context_kind,active_worker_id,active_scratch_root_id,worktree_mode,protected_label,archived_at) SELECT ${literal(chat)},${literal(owner)},'standalone',${literal(worker)},${literal(rootId)},NULL,protected_label,${date(archived)} FROM chats WHERE id=${literal(h.scope.chatId)}`,
          `INSERT INTO standalone_chat_roots(id,chat_id,owner_id,worker_id,status,protected_path_handle,archived_at,archive_expires_at) VALUES(${literal(rootId)},${literal(chat)},${literal(owner)},${literal(worker)},'ready','ctrr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',${date(expires === null ? null : archived)},${date(expires)})`,
        ];
        const retained = await retentionControls(
          h,
          id,
          projectSeed,
          scratchSeed,
        );
        const snapshot = async (chat, rootId, project) =>
          (
            await h.fixture.sql(
              [],
              [
                `SELECT jsonb_build_object('chatExists',EXISTS(SELECT 1 FROM chats WHERE id=${literal(chat)}),'projectChatExists',EXISTS(SELECT 1 FROM chats WHERE id=${literal(project)}),'rootExists',EXISTS(SELECT 1 FROM standalone_chat_roots WHERE id=${literal(rootId)}),'jobs',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'rootId',root_id,'chatId',chat_id,'workerId',worker_id,'kind',kind,'state',state,'attempt',attempt,'lastErrorCode',last_error_code,'errorRetryable',error_retryable)),'[]') FROM standalone_chat_root_jobs WHERE chat_id=${literal(chat)}))::text result`,
              ],
            )
          )[0];
        const eventsFor = (chat, offset) =>
          h.live.history
            .slice(offset)
            .filter(
              (e) =>
                e.type === "event" &&
                e.scope.kind === "current-user" &&
                e.resource === "chat" &&
                e.entityId === chat,
            );
        const complete = async (chat, rootId, project, offset) => {
          const state = await until(
            () => snapshot(chat, rootId, project),
            (s) => s.jobs[0]?.state === "succeeded",
          );
          assert.equal(state.chatExists, false);
          assert.equal(state.projectChatExists, false);
          assert.equal(state.rootExists, false);
          assert.equal(state.jobs.length, 1);
          const job = state.jobs[0];
          assert.match(job.id, /^[0-9a-f-]{36}$/);
          assert.equal(job.attempt, 1);
          assert.equal(job.kind, "delete");
          assert.equal(job.rootId, rootId);
          assert.equal(job.chatId, chat);
          assert.equal(job.workerId, h.scope.workerId);
          assert.equal(job.lastErrorCode, null);
          assert.equal(job.errorRetryable, null);
          assert.deepEqual(
            result.commands.filter((c) => c.chatId === chat),
            [
              {
                type: "chat.scratch.delete",
                rootId,
                chatId: chat,
                jobId: job.id,
                attempt: 1,
              },
            ],
          );
          const events = await until(
            () => eventsFor(chat, offset),
            (e) => e.length >= 2,
          );
          for (const [i, event] of events.entries()) {
            if (i) assert.ok(event.cursor > events[i - 1].cursor);
            assert.ok(Date.parse(event.occurredAt) <= Date.now());
          }
          const plain = events.map(({ cursor, occurredAt, ...event }) => event);
          assert.deepEqual(
            plain,
            Array.from({ length: 2 }, () => ({
              type: "event",
              scope: { kind: "current-user" },
              resource: "chat",
              action: "invalidated",
              entityId: chat,
              revision: null,
              payload: null,
            })),
          );
          result.invalidations.push(...plain);
          return {
            ...state,
            jobs: state.jobs.map(({ id: jobId, ...job }) => job),
          };
        };
        let offset = h.live.history.length;
        await h.fixture.sql([
          projectSeed(projectChat),
          ...scratchSeed(standalone, scratch),
        ]);
        assert.deepEqual(
          await h.visit("project and standalone cleanup", "POST", route, {
            json: { ignored: true },
          }),
          { deleted: 2 },
        );
        result.first = await complete(standalone, scratch, projectChat, offset);
        assert.deepEqual(
          await h.visit("repeated cleanup ignores null", "POST", route, {
            json: null,
          }),
          { deleted: 0 },
        );
        const failedProject = id(4),
          failedChat = id(5),
          failedRoot = id(6);
        offset = h.live.history.length;
        await h.fixture.sql([
          projectSeed(failedProject),
          ...scratchSeed(failedChat, failedRoot),
          `CREATE FUNCTION archive_cleanup_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.chat_id=${literal(failedChat)} THEN RAISE EXCEPTION 'Controlled archive scratch transaction failure'; END IF; RETURN NEW; END $$`,
          `CREATE TRIGGER archive_cleanup_fault BEFORE INSERT ON standalone_chat_root_jobs FOR EACH ROW EXECUTE FUNCTION archive_cleanup_fault()`,
        ]);
        await h.visit("scratch failure after project commit", "POST", route, {
          status: 500,
          json: {},
        });
        assert.deepEqual(
          await snapshot(failedChat, failedRoot, failedProject),
          {
            chatExists: true,
            projectChatExists: false,
            rootExists: true,
            jobs: [],
          },
        );
        assert.equal(eventsFor(failedChat, offset).length, 0);
        await h.fixture.sql([
          "DROP TRIGGER archive_cleanup_fault ON standalone_chat_root_jobs",
          "DROP FUNCTION archive_cleanup_fault()",
        ]);
        assert.deepEqual(
          await h.visit(
            "retry preserves earlier project cleanup",
            "POST",
            route,
            {},
          ),
          { deleted: 1 },
        );
        result.retried = await complete(
          failedChat,
          failedRoot,
          failedProject,
          offset,
        );
        result.retention = await retained.unchanged();

        const racedProject = id(30),
          racedChat = id(31),
          racedRoot = id(32);
        offset = h.live.history.length;
        await h.fixture.sql([
          projectSeed(racedProject),
          ...scratchSeed(racedChat, racedRoot),
        ]);
        const responses = await Promise.all(
          ["left", "right"].map((side) =>
            h.fixture.observe("concurrent cleanup " + side, "POST", route, {
              csrf: true,
              json: {},
            }),
          ),
        );
        const counts = responses.map((response) => {
          assert.deepEqual(Object.keys(response.body), ["deleted"]);
          assert.ok(Number.isSafeInteger(response.body.deleted));
          assert.ok(response.body.deleted >= 0 && response.body.deleted <= 2);
          return response.body.deleted;
        });
        assert.equal(
          counts.reduce((a, b) => a + b, 0),
          2,
        );
        result.concurrentResponses = responses;
        result.raced = await complete(
          racedChat,
          racedRoot,
          racedProject,
          offset,
        );
        // Keep each raw winner/count outcome above. Separate project/scratch
        // commits allow either request to win each phase; receipts and effects
        // must still be unique for both actual implementations.
        result.concurrent = { totalDeleted: 2, jobs: 1, commands: 1 };
        result.retention = await retained.unchanged();

        if (profile === "accounts") {
          const foreign = await foreignOwnerControl(h, id, scratchSeed);
          assert.deepEqual(
            await h.visit("body owner cannot redirect cleanup", "POST", route, {
              json: { ownerId: foreign.owner },
            }),
            { deleted: 0 },
          );
          await foreign.unchanged();
          result.foreignOwner = await foreign.clean(until);
          result.retention = await retained.unchanged();
        }
        assert.deepEqual(
          await h.visit("final empty cleanup", "POST", route, {}),
          { deleted: 0 },
        );
        const durable = await durabilitySnapshot(h, retained, [
          standalone,
          failedChat,
          racedChat,
        ]);
        assert.equal(durable.jobs.length, 3);
        assert.ok(
          durable.jobs.every(
            (job) => job.state === "succeeded" && job.attempt === 1,
          ),
        );
        const commands = result.commands.length;
        h.worker.close();
        const port = Number(new URL(h.fixture.server.origin).port);
        await h.fixture.close();
        await h.fixture.start({ port });
        assert.deepEqual(
          await h.visit(
            "cleanup remains empty after server restart",
            "POST",
            route,
            { json: null },
          ),
          { deleted: 0 },
        );
        assert.deepEqual(
          await durabilitySnapshot(h, retained, [
            standalone,
            failedChat,
            racedChat,
          ]),
          durable,
        );
        assert.equal(result.commands.length, commands);
        result.restart = {
          completedJobs: durable.jobs.length,
          duplicateCommands: 0,
          retainedChats: durable.chats.length,
          retainedRoots: durable.roots.length,
        };
        await productionBodyChecks(h, server, profile);
        result.success = true;
      } catch (error) {
        result.error = error.stack ?? String(error);
        result.diagnostics = h?.diagnostics();
        throw error;
      } finally {
        await h?.close();
      }
    }
    assert.deepEqual(runtimes[1].first, runtimes[0].first);
    assert.deepEqual(runtimes[1].retried, runtimes[0].retried);
    assert.deepEqual(runtimes[1].raced, runtimes[0].raced);
    assert.deepEqual(runtimes[1].concurrent, runtimes[0].concurrent);
    assert.deepEqual(runtimes[1].retention, runtimes[0].retention);
    assert.deepEqual(runtimes[1].foreignOwner, runtimes[0].foreignOwner);
    assert.deepEqual(runtimes[1].restart, runtimes[0].restart);
    assert.deepEqual(runtimes[1].invalidations, runtimes[0].invalidations);
    assert.deepEqual(runtimes[1].observations, runtimes[0].observations);
  }
  report.success = true;
} catch (error) {
  failure = error;
  report.error = error.stack ?? String(error);
} finally {
  try {
    await pg?.close();
  } catch (error) {
    failure ??= error;
    report.databaseCleanupFailure = String(error);
  }
  if (option("--report")) {
    const destination = path.resolve(option("--report"));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, JSON.stringify(report, null, 2) + "\n");
  }
  if (!failure) await rm(root, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(
  JSON.stringify({
    suite: report.suite,
    databaseMode,
    profiles: report.profiles.length,
    pairedObservations: report.profiles.reduce(
      (total, profile) => total + profile.runtimes[0].observations.length,
      0,
    ),
    passed: true,
  }),
);
