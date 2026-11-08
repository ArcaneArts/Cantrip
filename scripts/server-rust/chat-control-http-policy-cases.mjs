import assert from "node:assert/strict";
import { chat, standalone, lane } from "./chat-control-state.mjs";

export async function chatControlPolicyCases({ f, settle }) {
  const path = (suffix, id = chat) => `/api/chats/${id}/${suffix}`;
  const noCommands = ({ commands }) => assert.deepEqual(commands, []);
  for (const [method, suffix] of [
    ["GET", "worktree"],
    ["POST", "worktree"],
    ["PATCH", "compact"],
    ["GET", "compact"],
    ["POST", "execution-lanes"],
    ["PATCH", `execution-lanes/${lane(1)}/release`],
    ["GET", `execution-lanes/${lane(1)}/release`],
  ])
    await settle(
      `unregistered ${method} ${suffix}`,
      method,
      path(suffix),
      { status: 404 },
      noCommands,
    );
  await settle(
    "unregistered standalone method has no matched IDE guard",
    "GET",
    path("worktree", standalone),
    { status: 404 },
    noCommands,
  );
  for (const [method, suffix] of [
    ["PATCH", "worktree"],
    ["POST", "compact"],
    ["POST", `execution-lanes/${lane(1)}/release`],
  ])
    await settle(
      `malformed JSON ${suffix}`,
      method,
      path(suffix),
      {
        raw: "{",
        headers: { "content-type": "application/json" },
        status: 400,
      },
      noCommands,
    );
  await settle(
    "malformed JSON precedes standalone IDE guard",
    "PATCH",
    path("worktree", standalone),
    { raw: "{", headers: { "content-type": "application/json" }, status: 400 },
    noCommands,
  );
  await settle(
    "standalone IDE guard precedes selection field validation",
    "PATCH",
    path("worktree", standalone),
    { json: {}, status: 409 },
    noCommands,
  );
  await settle(
    "standalone IDE guard precedes release field validation",
    "POST",
    path(`execution-lanes/${lane(1)}/release`, standalone),
    { json: [], status: 409 },
    noCommands,
  );
  await settle(
    "HEAD standalone lane guard",
    "HEAD",
    path("execution-lanes", standalone),
    { status: 409, compareContentLength: true },
    noCommands,
  );
  if (f.name !== "none") {
    for (const [method, suffix] of [
      ["PATCH", "worktree"],
      ["POST", "compact"],
      ["GET", "execution-lanes"],
      ["POST", `execution-lanes/${lane(1)}/release`],
    ])
      await settle(
        `unauthenticated ${method} ${suffix}`,
        method,
        path(suffix),
        { client: "anonymous", csrf: false, status: 401 },
        noCommands,
      );
    for (const [method, suffix] of [
      ["PATCH", "worktree"],
      ["POST", "compact"],
      ["POST", `execution-lanes/${lane(1)}/release`],
    ])
      await settle(
        `missing CSRF ${suffix}`,
        method,
        path(suffix),
        { csrf: false, status: 403 },
        noCommands,
      );
  }
}
