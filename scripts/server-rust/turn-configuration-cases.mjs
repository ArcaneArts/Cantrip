import assert from "node:assert/strict";
export async function runTurnConfigurationCases({ observe, contexts }) {
  const configuration = [
    { name: "inherits the bound model configuration", input: {} },
    { name: "explicit null root effort", input: { reasoningEffort: null } },
    {
      name: "effort trims only in parsed model configuration",
      input: { reasoningEffort: " low " },
    },
    {
      name: "explicit child model",
      input: {
        customSubagentModel: true,
        subagentModelId: " child-two ",
        subagentReasoningEffort: " high ",
      },
    },
    { name: "null custom flag inherits", input: { customSubagentModel: null } },
    {
      name: "disabled child retains selected child metadata",
      input: { customSubagentModel: false },
    },
    {
      name: "selected custom child cannot be cleared",
      input: { subagentModelId: null },
      error: true,
    },
    {
      name: "empty root effort is invalid",
      input: { reasoningEffort: " " },
      error: true,
    },
    {
      name: "root effort type is preserved",
      input: { reasoningEffort: 3 },
      error: true,
    },
    {
      name: "custom flag type is preserved",
      input: { customSubagentModel: "false" },
      error: true,
    },
    {
      name: "standalone drops child configuration",
      standalone: true,
      input: {
        customSubagentModel: true,
        subagentModelId: 3,
        subagentReasoningEffort: false,
      },
    },
    {
      name: "standalone retains explicit null root effort",
      standalone: true,
      input: { reasoningEffort: null },
    },
  ];
  for (const test of configuration) {
    const result = await observe(
      "turn configuration: " + test.name,
      (i) => ({
        context: {
          ...contexts[i],
          contextKind: test.standalone ? "standalone" : "project",
          reasoningEffort: " medium ",
          modelConfiguration: {
            modelId: null,
            reasoningEffort: null,
            customSubagentModel: true,
            subagentModelId: "child",
            subagentReasoningEffort: "high",
          },
        },
        input: test.input,
        model: " root ",
      }),
      {
        op: "native-command-gui-configuration",
        shape: "raw",
        error: !!test.error,
      },
    );
    if (!test.error)
      for (const value of result) {
        assert.equal(value.turnModelConfiguration.modelId, "root");
        if (test.standalone) {
          assert.equal(value.turnModelConfiguration.customSubagentModel, false);
          assert.equal(value.turnModelConfiguration.subagentModelId, null);
          assert.equal(
            value.turnModelConfiguration.subagentReasoningEffort,
            null,
          );
        }
      }
  }
  for (const [name, input, options, error] of [
    ["ordinary standalone", {}, {}, false],
    ["explicit standalone default", { mode: "default" }, {}, false],
    ["standalone null mode", { mode: null }, {}, true],
    ["standalone plan mode", { mode: "plan" }, {}, true],
    ["standalone Task messages", {}, { encryptedTaskMessages: {} }, true],
    ["standalone Task dispatch", {}, { taskDispatchLease: {} }, true],
    [
      "standalone structured contract",
      {},
      { structuredResult: { outputSchema: {} } },
      true,
    ],
    [
      "standalone empty structured contract",
      {},
      { structuredResult: {} },
      true,
    ],
    [
      "standalone absent/falsy Task options",
      {},
      {
        structuredResult: null,
        encryptedTaskMessages: false,
        taskDispatchLease: null,
      },
      false,
    ],
  ])
    await observe(
      "turn validation: " + name,
      (i) => ({
        context: { ...contexts[i], contextKind: "standalone" },
        input,
        options,
      }),
      { op: "native-command-gui-validate", shape: "raw", error },
    );
  for (const [structuredResult, error] of [
    [null, false],
    [false, false],
    [{}, true],
    [{ outputSchema: {} }, false],
    [{ taskOperation: {} }, false],
    [{ outputSchema: {}, taskOperation: {} }, true],
    [{ outputSchema: null, taskOperation: null }, true],
    [{ outputSchema: false, taskOperation: {} }, false],
    [[], true],
  ]) {
    await observe(
      "turn validation project structured " + JSON.stringify(structuredResult),
      (i) => ({
        context: contexts[i],
        input: {},
        options: { structuredResult },
      }),
      { op: "native-command-gui-validate", shape: "raw", error },
    );
  }
}
