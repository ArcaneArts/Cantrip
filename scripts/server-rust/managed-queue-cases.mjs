import { runManagedQueueMutationCases } from "./managed-queue-mutation-cases.mjs";
import { runManagedQueueClaimCases } from "./managed-queue-claim-cases.mjs";
import { runManagedQueueDeliveryCases } from "./managed-queue-delivery-cases.mjs";
import { runManagedQueueFaultCases } from "./managed-queue-fault-cases.mjs";
import assert from "node:assert/strict";
import {
  managedQueueMutateSchema,
  managedQueueImportSchema,
  managedQueueImportAckSchema,
} from "../../packages/protocol/dist/index.js";
import { command } from "./native-command-admission-cases.mjs";

import { literal, stamp, otherOwner } from "./project-target-state.mjs";
import { runManagedQueueImportCases } from "./managed-queue-import-cases.mjs";
export async function runManagedQueueCases(h) {
  const { seed, observe, snapshot, reset, owner } = h;
  let n = 0;
  await seed(
    `INSERT INTO model_profiles(id,owner_id,name,created_at,updated_at) VALUES('queue-model',${literal(owner)},'Queue model',${literal(stamp)},${literal(stamp)}),('queue-model-two',${literal(owner)},'Second model',${literal(stamp)},${literal(stamp)}) ON CONFLICT DO NOTHING`,
  );
  async function setup() {
    await reset();
    await seed([
      "UPDATE chats SET experience='agent' WHERE id='chat'",
      `UPDATE managed_queue_states SET notified_revision=-1,notification_due_at=${literal(stamp)}`,
    ]);
  }
  const call = async (action, name, input = {}, options = {}) => {
    const result = await observe(
      name,
      (i) => ({
        action,
        chat: "chat",
        ...(typeof input === "function" ? input(i) : input),
      }),
      { op: "native-command-managed-queue-run", shape: "raw", ...options },
    );
    await snapshot(name + " persisted state");
    return result;
  };
  const request = (
    mutation,
    { revision = 0, operation = `managed-queue-${++n}`, ...changes } = {},
  ) =>
    managedQueueMutateSchema.parse({
      expectedRevision: revision,
      mutation,
      admission: command({
        method: `thread/queue/${mutation.kind}`,
        operationId: operation,
        ...changes,
      }),
    });
  const mutate = async (
    name,
    input,
    { status = "applied", rejection, ...options } = {},
  ) => {
    const { options: repositoryOptions, ...observation } = options;
    const result = await call(
      "mutate",
      name,
      { content: input, options: repositoryOptions },
      observation,
    );
    if (!options.error)
      for (const r of result) {
        assert.equal(r.receipt.status, status, name);
        if (rejection) assert.equal(r.receipt.rejectionCode, rejection, name);
      }
    return result;
  };
  const read = { worker: "alpha", session: command().session };
  const assertUnchanged = async (name, fn) => {
    const before = await snapshot("before " + name);
    const result = await fn();
    assert.deepEqual(await snapshot("unchanged " + name), before, name);
    return result;
  };
  await setup();
  for (const action of [
    "snapshot",
    "read",
    "claim-next",
    "pending-dispatches",
    "pending-notifications",
  ]) {
    const result = await call(action, "empty queue " + action, read);
    if (["snapshot", "read"].includes(action))
      for (const r of result)
        assert.deepEqual(r, {
          revision: 0,
          paused: false,
          items: [],
          claims: [],
          pendingImports: [],
        });
  }
  for (const [name, input, code] of [
    ["wrong worker", { ...read, worker: "beta" }, "stale-queue-session"],
    ...[
      "threadId",
      "projectId",
      "placementId",
      "modelRouteId",
      "providerAccountId",
    ].map((key) => [
      "stale " + key,
      { ...read, session: { ...read.session, [key]: "stale" } },
      "stale-queue-session",
    ]),
    [
      "Task queue",
      { ...read, session: { ...read.session, chatId: "task" } },
      "managed-session-ineligible",
    ],
    [
      "standalone queue",
      { ...read, session: { ...read.session, chatId: h.standalone } },
      "managed-session-ineligible",
    ],
  ])
    await assertUnchanged(name, () =>
      call("read", name, input, { error: true, code }),
    );
  await assertUnchanged("queue tenant isolation", () =>
    call(
      "snapshot",
      "queue tenant isolation",
      {},
      {
        requestOwner: otherOwner,
        error: true,
        code: "managed-session-ineligible",
      },
    ),
  );
  await call("read", "runtime and connection do not define queue placement", {
    ...read,
    session: { ...read.session, runtimeGeneration: "old", connectionId: "old" },
  });
  const context = {
    ...h,
    setup,
    call,
    request,
    mutate,
    read,
    assertUnchanged,
    managedQueueImportSchema,
    managedQueueImportAckSchema,
  };
  await runManagedQueueMutationCases(context);
  await runManagedQueueFaultCases(context);
  await runManagedQueueClaimCases(context);
  await runManagedQueueImportCases(context);
  await runManagedQueueDeliveryCases(context);
  await setup();
}
