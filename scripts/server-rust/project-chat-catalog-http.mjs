// Exact project Chat catalogs over real HTTP, including ordering and archives.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustServer, buildRustExample } from "./build.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { hashPassword } from "../../cantrip_server/src/auth/service.ts";
import { ARCHIVED_CHAT_RETENTION_MS } from "../../cantrip_server/src/db/repository.ts";
import { password } from "./security-fixtures.mjs";
import { literal } from "./project-target-state.mjs";
import {
  settingsHttpFixture,
  settingsProject,
  settingsChat,
} from "./native-settings-http-fixture.mjs";

const option = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite",
  reportPath = option("--report");
const root = await mkdtemp(
  path.join(tmpdir(), "cantrip-project-chat-catalog-"),
);
const id = (n) => `f7f7f7f7-7777-4777-8777-${String(n).padStart(12, "0")}`;
const live = [id(1), id(2)],
  archived = [id(3), id(4)];
const report = {
  suite: "project-chat-catalog-http",
  databaseMode,
  completeReplacement: false,
  profiles: [],
};
let pg, active, failure;
try {
  const executable = await buildRustServer(),
    repositoryExecutable = await buildRustExample("project-repository-fixture");
  const passwordHash = await hashPassword(password);
  if (databaseMode !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const profile of ["none", "password", "accounts"].filter(
    (p) => !option("--profile") || p === option("--profile"),
  )) {
    const outputs = [];
    report.profiles.push({ profile, outputs });
    for (const kind of ["node", "rust"]) {
      const result = { kind, observations: [], snapshotProofs: 0 };
      outputs.push(result);
      const url =
        pg && (kind === "node" || databaseMode === "postgres")
          ? await pg.database()
          : undefined;
      const h = (active = await settingsHttpFixture({
        kind,
        profile,
        root,
        executable,
        repositoryExecutable,
        databaseMode,
        url,
        passwordHash,
        result,
        configure: () => [
          `UPDATE chats SET position=0,created_at='2026-10-25T00:00:00Z',updated_at='2026-10-25T00:00:00Z' WHERE id=${literal(settingsChat)}`,
          ...[...live, ...archived].map(
            (chat, index) =>
              `INSERT INTO chats(id,owner_id,project_id,active_worktree_id,active_worker_id,protected_label,experience,position,archived_at,created_at,updated_at) SELECT ${literal(chat)},owner_id,project_id,active_worktree_id,active_worker_id,protected_label,${literal([live[1], archived[1]].includes(chat) ? "task" : "agent")},1,${index < 2 ? "NULL" : literal(`2026-10-25T0${6 - index}:00:00Z`)},${literal(`2026-10-25T0${4 - index}:00:00Z`)},'2026-10-25T00:00:00Z' FROM chats WHERE id=${literal(settingsChat)}`,
          ),
          ...[1, 2].map(
            (n) =>
              `INSERT INTO chat_messages(id,chat_id,worktree_id,role,content) SELECT ${literal(id(20 + n))},${literal(archived[0])},active_worktree_id,'user','[]'::jsonb FROM chats WHERE id=${literal(archived[0])}`,
          ),
        ],
      }));
      const expiry = [4, 3].map((hour) =>
        new Date(
          Date.parse(`2026-10-25T0${hour}:00:00Z`) + ARCHIVED_CHAT_RETENTION_MS,
        ).toISOString(),
      );
      for (const value of expiry) h.fixture.chatArchiveExpirations.add(value);
      const catalog = await h.visit(
        "project Chat list order and Task experience",
        "GET",
        `/api/projects/${settingsProject}/chats`,
      );
      assert.deepEqual(
        catalog.map((chat) => chat.id),
        [settingsChat, live[1], live[0]],
      );
      assert.equal(catalog[1].experience, "task");
      const archive = await h.visit(
        "archived project Chats and message counts",
        "GET",
        `/api/projects/${settingsProject}/archived-chats`,
      );
      assert.deepEqual(
        archive.map((chat) => chat.id),
        archived,
      );
      assert.deepEqual(
        archive.map((chat) => chat.messageCount),
        [2, 0],
      );
      assert.deepEqual(
        archive.map((chat) => chat.expiresAt),
        expiry,
      );
      assert.deepEqual(
        archive.map((chat) => chat.experience),
        ["agent", "task"],
      );
      for (const suffix of ["chats", "archived-chats"]) {
        await h.visit(
          "HEAD " + suffix,
          "HEAD",
          `/api/projects/${settingsProject}/${suffix}`,
        );
        assert.deepEqual(
          await h.visit(
            "missing project " + suffix,
            "GET",
            `/api/projects/${id(99)}/${suffix}`,
          ),
          [],
        );
        if (profile === "accounts")
          assert.deepEqual(
            await h.visit(
              "foreign owner " + suffix,
              "GET",
              `/api/projects/${settingsProject}/${suffix}`,
              { client: "other" },
            ),
            [],
          );
      }
      await h.close();
      active = undefined;
    }
    assert.deepEqual(outputs[1].observations, outputs[0].observations, profile);
  }
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
  report.diagnostics = active?.diagnostics();
  report.retainedRoot = root;
} finally {
  await active?.close();
  await pg?.close();
  if (reportPath) {
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  }
  if (!failure) await rm(root, { recursive: true, force: true });
}
console.log(
  JSON.stringify({
    suite: report.suite,
    databaseMode,
    profiles: report.profiles.map(({ profile, outputs }) => ({
      profile,
      observations: outputs.map((o) => o.observations.length),
    })),
    failure: report.failure ?? null,
  }),
);
if (failure) throw failure;
