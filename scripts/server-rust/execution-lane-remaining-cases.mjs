import assert from "node:assert/strict";
import { runLaneReadCases } from "./execution-lane-read-cases.mjs";
import { runLaneReleaseCases } from "./execution-lane-release-cases.mjs";
import { runLaneTransitionCases } from "./execution-lane-transition-cases.mjs";
import { runLaneRestartCases } from "./execution-lane-restart-cases.mjs";
import { runLaneReservationCases } from "./execution-lane-reservation-cases.mjs";
export async function runRemainingLaneCases(h) {
  const { observe, reset, seed, snapshot } = h;
  async function start({ chat = "chat", worktree, finish = false } = {}) {
    await reset();
    if (worktree)
      await seed(
        `UPDATE chats SET active_worktree_id='${worktree}' WHERE id='chat'`,
      );
    const contexts = await observe("remaining lane fixture start", { chat });
    const ids = contexts.map((c) => c.executionLaneId);
    if (finish)
      await observe("remaining lane fixture finish", (i) => ({
        action: "finish",
        chat,
        lane: ids[i],
      }));
    return {
      contexts,
      ids,
      chat,
      key: (i, extra = {}) => ({ chat, lane: ids[i], ...extra }),
    };
  }
  const call = (action, name, input = {}, options = {}) =>
    observe(
      name,
      (i) => ({ action, ...(typeof input === "function" ? input(i) : input) }),
      options,
    );
  async function unchanged(name, action) {
    const before = await snapshot("before " + name);
    const result = await action();
    assert.deepEqual(await snapshot("read or rollback " + name), before);
    return result;
  }
  const helpers = { ...h, start, call, unchanged };
  await runLaneReadCases(helpers);
  await runLaneReleaseCases(helpers);
  await runLaneTransitionCases(helpers);
  await runLaneReservationCases(helpers);
  await runLaneRestartCases(helpers);
}
