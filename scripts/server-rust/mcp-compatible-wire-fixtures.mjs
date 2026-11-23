import * as p from "../../packages/protocol/dist/index.js";

export function mcpCompatibleWireFixtures(fixtures) {
  const canonical = fixtures.workerCantripMcpOperationCallSchema[0];
  const legacy = structuredClone(canonical);
  legacy.binding.canonicalRoot = "/worker-private/legacy-root";
  delete legacy.binding.contextKind;
  delete legacy.binding.scratchRootId;
  const future = structuredClone(canonical);
  future.binding.allowedOperations.push("future.unknown.operation");
  future.binding.futureClaim = "never grants authority";
  const standalone = structuredClone(canonical);
  Object.assign(standalone.binding, {
    contextKind: "standalone",
    projectId: null,
    worktreeId: null,
    rootKind: null,
    scratchRootId: "fixture-scratch-root",
  });
  const fullLegacy = structuredClone(legacy);
  fullLegacy.binding.allowedOperations = [
    "task.list",
    ...Array.from({ length: 99 }, (_, i) => "future.operation." + i),
  ];
  return {
    compatibleWorkerCantripMcpOperationCallSchema: [
      structuredClone(canonical),
      legacy,
      future,
      standalone,
      fullLegacy,
    ],
    cantripAgentOperationNameSchema: [
      ...p.cantripAgentOperationNameSchema.options,
    ],
  };
}

export function* mcpCompatibleWireCases(name, samples) {
  if (name === "cantripAgentOperationNameSchema") {
    yield* [
      "future.unknown",
      "TASK.LIST",
      " task.list ",
      "constructor",
      "\ud800",
    ];
    return;
  }
  if (name !== "compatibleWorkerCantripMcpOperationCallSchema") return;
  for (const operations of [
    ["future.unknown"],
    ["task.list", "task.list", "future.unknown"],
    ["task.list", "future.\ud800", "future.😀"],
    ["task.list", "x".repeat(101)],
    Array.from({ length: 101 }, () => "future.unknown"),
  ]) {
    const input = structuredClone(samples[0]);
    input.binding.allowedOperations = operations;
    yield input;
  }
  for (const length of [0, 8192, 8193]) {
    const input = structuredClone(samples[1]);
    input.binding.canonicalRoot = "x".repeat(length);
    yield input;
  }
}
