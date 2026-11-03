// Complete inference status and worker-event inputs for the Source/native oracle.
export const inferenceWorkerEvents = [
  ...["waiting", "preparing", "running"].map((state, sequence) => ({
    type: "inference.command-state",
    sequence,
    state,
  })),
  {
    type: "agent.automatic-label",
    chatId: "fixture-chat",
    claimId: "00000000-0000-4000-8000-000000000001",
    result: null,
  },
  {
    type: "agent.automatic-label",
    chatId: "fixture-chat",
    claimId: "00000000-0000-4000-8000-000000000001",
    result: { titleProtection: null },
  },
];

const identity = {
  serverId: "fixture-server",
  ownerId: "fixture-owner",
  workerId: "fixture-worker",
  workerGeneration: "fixture-generation",
  revision: 0,
};
export const inferenceWireFixtures = {
  workerInferenceStatusSchema: [
    { ...identity, pools: [] },
    {
      ...identity,
      pools: [
        {
          providerId: "fixture-provider",
          activeCount: 0,
          queuedCount: 0,
          operations: [],
        },
      ],
    },
    {
      ...identity,
      revision: 1,
      pools: [
        {
          providerId: "fixture-provider",
          maxConcurrentInference: 2,
          inferenceConfigRevision: 3,
          activeCount: 2,
          queuedCount: 1,
          operations: [
            "waiting",
            "granted",
            "running",
            "cancelling",
            "suspended",
            "released",
          ].map((state, index) => ({
            operationId: `fixture-operation-${index}`,
            runtimeGeneration: "fixture-runtime",
            providerId: "fixture-provider",
            chatId: index === 0 ? null : "fixture-chat",
            projectId: index === 0 ? null : "fixture-project",
            state,
            queuePosition: state === "waiting" ? 1 : null,
            enqueuedAt: 0,
            grantedAt: state === "waiting" ? null : 1,
            startedAt: ["waiting", "granted"].includes(state) ? null : 2,
          })),
        },
      ],
    },
  ],
};

const detailedStatus = inferenceWireFixtures.workerInferenceStatusSchema.at(-1);
for (const purpose of ["turn", "label", "child", "helper"])
  inferenceWireFixtures.workerInferenceStatusSchema.push({
    ...detailedStatus,
    pools: detailedStatus.pools.map((pool) => ({
      ...pool,
      operations: pool.operations.map((operation) => ({
        ...operation,
        purpose,
      })),
    })),
  });

export const inferenceNotifications =
  inferenceWireFixtures.workerInferenceStatusSchema.map((status) => ({
    kind: "notification",
    notification: { type: "inference.status", status },
  }));

export const inferenceLiveMessages =
  inferenceWireFixtures.workerInferenceStatusSchema.map((status) => ({
    type: "event",
    cursor: 1,
    scope: { kind: "current-user" },
    resource: "worker-inference",
    action: "status",
    entityId: status.workerId,
    revision: status.revision,
    payload: status,
    occurredAt: "2026-11-04T00:00:00.000Z",
  }));
