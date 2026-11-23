// Real client disappearance and held production WorkerConnection responses.
import assert from "node:assert/strict";
import {
  projects,
  projectSql,
  literal,
  comparable,
} from "./project-administration-state.mjs";
import { eventually, auditRows } from "./audit-observations.mjs";
const deferred = () => {
  let resolve;
  return {
    promise: new Promise((r) => (resolve = r)),
    resolve: () => resolve(),
  };
};
export async function administrationBoundaries({
  f,
  live,
  state,
  snapshot,
  visit,
  result,
}) {
  const notify = (payload) =>
    f.sql([
      `SELECT pg_notify('cantrip_computer_use_authority',${literal(payload)})`,
    ]);
  const offset = state.authority.length;
  for (const payload of [
    "null",
    "[]",
    "{",
    JSON.stringify({
      ownerId: f.owner,
      scope: { kind: "project", projectId: projects.github },
      unknown: true,
    }),
    JSON.stringify({
      ownerId: f.owner,
      scope: { kind: "project", projectId: projects.github, unknown: true },
    }),
    JSON.stringify({ ownerId: "\n", scope: { kind: "chat", chatId: "chat" } }),
    JSON.stringify({
      ownerId: "x".repeat(257),
      scope: { kind: "chat", chatId: "chat" },
    }),
  ])
    await notify(payload);
  const valid = {
    ownerId: f.owner,
    scope: { kind: "project", projectId: projects.github },
  };
  await notify(JSON.stringify(valid));
  await eventually(
    () => state.authority.slice(offset),
    (actual) => assert.deepEqual(actual, [valid.scope]),
  );
  const authority = { delivered: state.authority.slice(offset) };
  const observations = [];
  for (const deleteFiles of [false, true]) {
    const id = deleteFiles
      ? "22222222-2222-4222-8222-000000900001"
      : "22222222-2222-4222-8222-000000900002";
    await f.sql(projectSql(f.owner, id, { resources: true }));
    await live.subscribed("held cleanup " + deleteFiles, [
      { kind: "current-user" },
      { kind: "project", projectId: id },
    ]);
    await live.ping("held cleanup before");
    const before = await snapshot(),
      commandsOffset = state.commands.length,
      liveOffset = live.frames.length;
    const release = deferred();
    let entered = 0,
      acknowledged = 0;
    state.intercept = async (command) => {
      if (
        command.type === "terminal.close" &&
        command.terminalId.startsWith(id)
      ) {
        entered++;
        await release.promise;
        acknowledged++;
      }
    };
    try {
      let clientResult;
      if (deleteFiles) {
        const client = f.client(),
          abort = new AbortController();
        const pending = fetch(f.server.origin + "/api/projects/" + id, {
          method: "DELETE",
          headers: {
            origin: "http://127.0.0.1:5173",
            "content-type": "application/json",
            cookie: [...client.cookies].map(([k, v]) => k + "=" + v).join("; "),
            ...(client.csrf ? { "x-cantrip-csrf": client.csrf } : {}),
          },
          body: JSON.stringify({ deleteLocalFiles: true }),
          signal: abort.signal,
        }).then(
          () => ({ resolved: true }),
          (error) => ({ name: error.name }),
        );
        await eventually(
          () => entered,
          (n) =>
            assert.equal(
              n,
              2,
              "both terminal closes begin before either acknowledgment",
            ),
        );
        assert.equal(acknowledged, 0);
        assert.deepEqual(
          await snapshot(),
          before,
          "file deletion waits for all terminal acknowledgments",
        );
        abort.abort();
        clientResult = await pending;
        assert.deepEqual(clientResult, { name: "AbortError" });
        release.resolve();
      } else {
        await visit(
          "preserving files does not await terminal acknowledgments",
          "DELETE",
          "/api/projects/" + id,
          { json: { deleteLocalFiles: false }, status: 204 },
        );
        assert.equal(entered, 2);
        assert.equal(
          acknowledged,
          0,
          "preserving-files HTTP response completes while terminal replies remain held",
        );
        clientResult = {
          status: 204,
          terminalAcknowledgmentsAtResponse: acknowledged,
        };
      }
      await eventually(snapshot, (value) =>
        assert.ok(
          !value.projects.some((p) => p.id === id),
          "admitted cleanup completes after caller disappearance",
        ),
      );
      const after = await snapshot();
      await live.ping("held cleanup after");
      const events = live.frames
        .slice(liveOffset)
        .filter((e) => e.type === "event" && e.resource === "project")
        .map(({ cursor, ...event }) => f.normalize(event));
      const audits = (await auditRows(f))
        .filter((e) => e.resource.id === id)
        .map((e) => ({
          action: e.action,
          result: e.result,
          resource: e.resource,
        }));
      release.resolve();
      await eventually(
        () => acknowledged,
        (n) => assert.equal(n, 2),
      );
      const commands = state.commands.slice(commandsOffset);
      assert.deepEqual(
        commands.map((c) => c.type),
        [
          "terminal.close",
          "terminal.close",
          ...(deleteFiles ? ["project.files.delete"] : []),
          "surface.close",
          "surface.close",
        ],
      );
      observations.push({
        deleteFiles,
        clientResult,
        before: comparable(before, f),
        after: comparable(after, f),
        commands,
        events,
        audits,
      });
    } finally {
      release.resolve();
      delete state.intercept;
    }
  }
  result.boundaries = { authority, observations };
}
