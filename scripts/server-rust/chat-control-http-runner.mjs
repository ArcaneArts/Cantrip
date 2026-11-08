import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { decryptChatMessageProtectedContent } from "../../packages/crypto/dist/index.js";
import { protectChatMessage } from "../../cantrip_worker/src/chat-message-encryption.ts";
import {
  settingsHttpFixture,
  componentKey,
} from "./native-settings-http-fixture.mjs";
import { chatControlCases } from "./chat-control-http-cases.mjs";
import { chatControlPolicyCases } from "./chat-control-http-policy-cases.mjs";
import { chatControlRestart } from "./chat-control-http-restart.mjs";
import { chatControlBoundaries } from "./chat-control-http-boundaries.mjs";
import { LiveProbe } from "./live-sockets.mjs";
import {
  expectedControlLogs,
  verifyControlLogs,
} from "./chat-control-http-logs.mjs";
import {
  chat,
  standalone,
  seed,
  snapshotQuery,
} from "./chat-control-state.mjs";

const primaryCommands = new Set([
  "worktree.status",
  "chat.message.protect",
  "chat.compact",
  "chat.thread.ensure",
]);
export async function runChatControl(options) {
  const result = options.result;
  const state = {
    mode: "normal",
    commands: [],
    background: [],
    protected: new Map(),
    proofs: [],
    aliases: new Map(),
    verified: new Map(),
  };
  const h = await settingsHttpFixture({
    ...options,
    liveSqlFixture: true,
    prepare: async ({ fixture, owner }) => {
      try {
        await fixture.sql(seed(owner));
      } catch (error) {
        error.message += "\n" + fixture.server.diagnostics();
        throw error;
      }
    },
    onCommand: async (command, _emit, { encryption }) => {
      if (!primaryCommands.has(command.type)) {
        if (command.type === "computer-use.preview.revoke") {
          state.background.push(command);
          return { closed: true };
        }
        if (command.type === "computer-use.observation.configure") {
          state.background.push(command);
          return { acceptedPaths: command.paths ?? [] };
        }
        return;
      }
      state.commands.push(structuredClone(command));
      await state.intercept?.(command);
      if (command.type === "worktree.status") {
        if (state.mode === "status-error")
          throw new Error("Controlled worktree status failure");
        if (state.mode === "status-invalid") return { invalid: true };
        return {
          worktree: {
            path: command.worktreePath,
            branch: "lane-1",
            head: "abc123",
            detached: false,
            isPrimary: false,
            managed: true,
            locked: false,
            lockReason: null,
            prunable: false,
            pruneReason: null,
            missing: false,
          },
          status: {
            branch: "lane-1",
            head: "abc123",
            upstream: null,
            ahead: 0,
            behind: 0,
            branches: [],
            files:
              state.mode === "dirty"
                ? [
                    {
                      path: "private-dirty.txt",
                      originalPath: null,
                      indexStatus: " ",
                      worktreeStatus: "M",
                      staged: false,
                      unstaged: true,
                    },
                  ]
                : [],
          },
        };
      }
      if (command.type === "chat.thread.ensure")
        return { threadId: "ensured-standalone" };
      if (command.type === "chat.compact") {
        if (state.mode === "compact-error")
          throw new Error("Controlled compaction failure");
        if (state.mode === "compact-invalid") return { accepted: false };
        return { accepted: true, ignored: "unknown acknowledgment field" };
      }
      if (state.mode === "protect-error")
        throw new Error("Controlled release protection failure");
      const protectedMessage = await protectChatMessage({
        id: command.message.id,
        message: command.message,
        service: encryption,
      });
      const opened = await decryptChatMessageProtectedContent({
        ownerId: encryption.ownerId(),
        messageId: protectedMessage.id,
        keyRevision: protectedMessage.protectedContent.keyRevision,
        componentKey,
        encrypted: protectedMessage.protectedContent,
        publicClassification: protectedMessage.classification,
      });
      assert.deepEqual(opened.content, command.message.content);
      await assert.rejects(() =>
        decryptChatMessageProtectedContent({
          ownerId: encryption.ownerId(),
          messageId: chat,
          keyRevision: protectedMessage.protectedContent.keyRevision,
          componentKey,
          encrypted: protectedMessage.protectedContent,
          publicClassification: protectedMessage.classification,
        }),
      );
      state.protected.set(protectedMessage.id, protectedMessage);
      state.aliases.set(
        protectedMessage.id,
        "<message:" + command.message.idempotencyKey + ">",
      );
      state.verified.set(
        protectedMessage.protectedContent.envelope.ciphertext,
        {
          protectedContent: protectedMessage.protectedContent,
          opened,
        },
      );
      state.proofs.push({
        id: protectedMessage.id,
        plaintext: opened,
        wrongMessageBindingRejected: true,
      });
      return protectedMessage;
    },
  });
  const f = h.fixture;
  let server = f.server;
  const servers = [server];
  result.processExits = [];
  const expectedLogs = [];
  const log = createWriteStream(options.logPath);
  log.write(server.diagnostics());
  const capture = (bytes) => log.write(bytes);
  server.child.stdout.on("data", capture);
  server.child.stderr.on("data", capture);
  function alias(snapshot) {
    for (const row of snapshot.chat_runtime_sessions)
      state.aliases.set(
        row.id,
        `<runtime:${row.chat_id}:${row.worktree_id ?? row.scratch_root_id}>`,
      );
    for (const row of snapshot.chat_execution_lanes)
      if (!/^77777777-/.test(row.id))
        state.aliases.set(
          row.id,
          `<lane:${row.chat_id}:${row.worktree_id}:${row.purpose}>`,
        );
  }
  function comparable(value, key = "") {
    const verified = state.verified.get(value?.envelope?.ciphertext);
    if (verified) {
      assert.deepEqual(value, verified.protectedContent);
      return comparable({ verifiedProtectedContent: verified.opened }, key);
    }
    if (Array.isArray(value)) return value.map((v) => comparable(v));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, comparable(v, k)]),
      );
    if (typeof value !== "string") return value;
    if (state.aliases.has(value)) return state.aliases.get(value);
    if (/(?:_at|At)$/.test(key) && /^\d{4}-/.test(value)) {
      assert.ok(
        Number.isFinite(Date.parse(value)),
        "valid durable/event timestamp",
      );
      return "<timestamp>";
    }
    return f.normalize(value, key);
  }
  const normalizeState = (s) =>
    Object.fromEntries(
      Object.entries(comparable(s)).map(([k, rows]) => [
        k,
        rows.sort((a, b) => String(a.id).localeCompare(String(b.id))),
      ]),
    );
  const snapshot = async () => (await f.sql([], [snapshotQuery]))[0];
  const processExit = () => {
    const exit = {
      code: server.child.exitCode,
      signal: server.child.signalCode,
    };
    assert.deepEqual(exit, { code: 0, signal: null });
    result.processExits.push(exit);
    result.processExit = exit;
  };
  const subscribe = () =>
    h.live.subscribed("chat controls", [
      { kind: "current-user" },
      { kind: "chat", chatId: chat },
      { kind: "chat", chatId: standalone },
    ]);
  const restart = async () => {
    const port = Number(new URL(server.origin).port);
    await h.live.close();
    h.worker.close();
    await f.close();
    processExit();
    await f.start({ port });
    server = f.server;
    servers.push(server);
    log.write(server.diagnostics());
    server.child.stdout.on("data", capture);
    server.child.stderr.on("data", capture);
    h.live = await new LiveProbe(f).open();
    await h.live.initialized();
    await subscribe();
  };
  async function proveRows(snapshot) {
    for (const row of snapshot.chat_messages) {
      const original = state.protected.get(row.id);
      assert.ok(
        original,
        "persisted message came from actual worker encryption",
      );
      assert.deepEqual(row.protected_content, original.protectedContent);
      assert.equal(row.role, original.classification.role);
      assert.equal(row.mode, original.classification.mode);
      assert.deepEqual(
        row.attachment_ids,
        original.classification.attachmentIds,
      );
      assert.ok(
        !JSON.stringify(row).includes("Released "),
        "SQL contains no release plaintext",
      );
    }
  }
  const settle = async (
    name,
    method,
    path,
    {
      setup = [],
      mode = "normal",
      unchanged = true,
      mutation,
      ...options
    } = {},
    check,
  ) => {
    if (setup.length) await f.sql(setup);
    state.mode = mode;
    await h.live.ping(name + " before");
    const before = await snapshot(),
      offset = state.commands.length,
      liveOffset = h.live.history.length;
    console.error(
      JSON.stringify({
        event: "chat-control.case",
        kind: options.kind ?? f.kind,
        profile: f.name,
        name,
      }),
    );
    const observation = await f.observe(name, method, path, {
      csrf: true,
      ...options,
    });
    const body = f.records.get(name),
      after = await snapshot();
    await h.live.ping(name + " after");
    alias(after);
    await proveRows(after);
    const commands = state.commands.slice(offset);
    expectedLogs.push(
      ...expectedControlLogs({
        path,
        observation,
        body,
        commands,
        before,
        mode,
      }),
    );
    const events = h.live.history
      .slice(liveOffset)
      .filter(
        (e) =>
          e.type === "event" && ["chat", "chat-message"].includes(e.resource),
      );
    const invalidations = events.filter((e) => e.resource === "chat");
    const successfulMutation =
      mutation ??
      (!["GET", "HEAD"].includes(method) && observation.status < 400);
    assert.equal(
      invalidations.length,
      successfulMutation ? 1 : 0,
      name + " response-completion Chat invalidation count",
    );
    if (successfulMutation)
      assert.deepEqual(
        comparable((({ cursor, ...rest }) => rest)(invalidations[0])),
        {
          type: "event",
          scope: { kind: "current-user" },
          resource: "chat",
          action: "invalidated",
          entityId: path.split("/")[3],
          revision: null,
          payload: null,
          occurredAt: "<timestamp>",
        },
      );
    if (unchanged)
      assert.deepEqual(
        after,
        before,
        name + " preserves all captured durable rows",
      );
    await check?.({ body, before, after, commands, events, h, state });
    result.cases.push({
      name,
      observation: { ...observation, body: comparable(body) },
      before: normalizeState(before),
      after: normalizeState(after),
      commands: comparable(commands),
      events: comparable(events.map(({ cursor, ...e }) => e)),
    });
    result.rawCases.push({ name, body, before, after, commands, events });
    return body;
  };
  try {
    await subscribe();
    await chatControlPolicyCases({ f, settle });
    await chatControlCases({ h, f, settle, state });
    if (options.boundaries) {
      const boundary = await chatControlBoundaries({
        h,
        f,
        state,
        snapshot,
        alias,
        comparable,
        normalizeState,
        proveRows,
        logPath: options.logPath,
      });
      result.boundaries = boundary.cases;
      expectedLogs.push(...boundary.logs);
    }
    await chatControlRestart({ settle, restart, snapshot });
    result.proofs = state.proofs;
    result.background = state.background;
  } finally {
    result.finalDiagnostics = server.diagnostics();
    try {
      await h.live.close();
      await h.close();
      processExit();
    } finally {
      for (const process of servers) {
        process.child.stdout.off("data", capture);
        process.child.stderr.off("data", capture);
      }
      await new Promise((resolve) => log.end(resolve));
    }
  }
  result.controlLogs = await verifyControlLogs(options.logPath, expectedLogs);
}
