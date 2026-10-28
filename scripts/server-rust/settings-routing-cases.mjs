import {
  reasoningStateForRuntimes,
  configurationReasoningStateForRuntimes,
  prepareRuntimesForReasoning,
} from "../../cantrip_server/src/models/reasoning.ts";
import {
  resolveModelRoutePairs,
  modelConfigurationFailure,
} from "../../cantrip_server/src/models/subagent-routing.ts";

export function routingCases(emit) {
  const attempt = (fn) => {
    try {
      return fn();
    } catch (error) {
      return { thrown: error.name };
    }
  };
  let seed = 912406;
  const random = (max) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % max;
  };
  const efforts = [null, "low", "medium", "high", "max", "", "\ud800"];
  function runtime(route, provider, account, choices, metadata = {}) {
    return {
      routeId: route,
      provider: {
        id: provider,
        ...(account === undefined ? {} : { accountId: account }),
        opaque: { key: "unchanged" },
      },
      model: {
        id: "model",
        name: route,
        reasoningEffort: "high",
        catalog:
          choices === null
            ? null
            : {
                supportedReasoningEfforts: choices.map((effort, i) => ({
                  effort,
                  description: `${route}:${i}:é`,
                })),
                reasoningMandatory: false,
                supportsReasoning: true,
                ...metadata,
              },
      },
    };
  }
  const a = runtime("a", "provider", undefined, ["low", "high"]),
    b = runtime("b", "provider", null, ["high", "max"]),
    c = runtime("c", "other", "account", ["low", "low", "max"], {
      reasoningMandatory: true,
    }),
    absent = runtime("absent", "provider", undefined, null);
  const groups = [
    [],
    [a],
    [a, b],
    [a, c],
    [absent],
    [a, absent],
    [c, a, b],
    [b, a, c],
    [
      runtime("same", "provider", "first", ["low"]),
      runtime("same", "provider", "second", ["max"]),
    ],
    [runtime("unknown", "provider", null, [], { supportsReasoning: null })],
  ];
  const reason = (runtimes, requested) => {
    const input = JSON.parse(
      JSON.stringify({ runtimes, requested, modelId: "model\ud800" }),
    );
    emit("reasoning", input, {
      intersection: attempt(() =>
        reasoningStateForRuntimes(
          input.modelId,
          input.requested,
          input.runtimes,
        ),
      ),
      union: attempt(() =>
        configurationReasoningStateForRuntimes(
          input.modelId,
          input.requested,
          input.runtimes,
        ),
      ),
      prepared: attempt(() =>
        prepareRuntimesForReasoning(input.runtimes, input.requested),
      ),
    });
  };
  const route = (raw) => {
    const input = JSON.parse(JSON.stringify(raw));
    try {
      emit("routing", input, {
        value: resolveModelRoutePairs(input),
        failure: null,
      });
    } catch (error) {
      const failure = modelConfigurationFailure(error);
      emit("routing", input, {
        value: null,
        failure,
        ...(!failure ? { thrown: error.name } : {}),
      });
    }
  };
  for (const roots of groups)
    for (const effort of efforts) reason(roots, effort);
  for (const rootRuntimes of groups)
    for (const subagentRuntimes of groups)
      for (const customSubagentModel of [false, true])
        for (const requested of efforts) {
          route({
            configuration: {
              modelId: "root",
              reasoningEffort: requested,
              customSubagentModel,
              subagentModelId: "sub",
              subagentReasoningEffort: requested,
            },
            rootRuntimes,
            subagentRuntimes,
          });
        }
  for (let i = 0; i < 2000; i++) {
    const make = () =>
      Array.from({ length: random(7) }, (_, n) =>
        runtime(
          ["route", "other", "\ud800", "�", String(n)][random(5)],
          ["provider", "other", "\ud800", "�"][random(4)],
          [undefined, null, "account", "other", "\ud800", "�"][random(6)],
          random(5) === 0
            ? null
            : ["low", "medium", "high", "max"].filter(() => random(3) > 0),
          {
            reasoningMandatory: [true, false, null][random(3)],
            supportsReasoning: [true, false, null][random(3)],
          },
        ),
      );
    const rootRuntimes = make(),
      subagentRuntimes = make();
    const effort = efforts[random(efforts.length)];
    reason(rootRuntimes, effort);
    route({
      configuration: {
        modelId: random(8) ? "root" : null,
        reasoningEffort: effort,
        customSubagentModel: Boolean(random(2)),
        subagentModelId: random(8) ? "sub" : null,
        subagentReasoningEffort: efforts[random(efforts.length)],
      },
      rootRuntimes,
      subagentRuntimes,
      workerConnected: [undefined, false, true][random(3)],
    });
  }
  const malformed = [
    undefined,
    null,
    {},
    "",
    "high",
    "🦀\ud800",
    false,
    true,
    0,
    [],
    [null],
    [false, 0, "x", [], {}],
    [{}],
    [{ effort: null }],
    [{ effort: false }, { effort: 0 }],
    [
      { effort: {}, description: null },
      { effort: {}, description: null },
    ],
    [
      { effort: [], description: null },
      { effort: [], description: null },
    ],
    [null, { effort: "high", description: null }],
    [{ effort: "high", description: null }, null],
    [{ effort: "low" }, { effort: "high" }, null],
    [{ effort: "high" }, null, { effort: "low" }],
  ];
  const bad = (options) =>
    runtime("bad", "provider", undefined, [], {
      supportedReasoningEfforts: options,
    });
  const configuration = (requested, custom = false) => ({
    modelId: "root",
    reasoningEffort: requested,
    customSubagentModel: custom,
    subagentModelId: "sub",
    subagentReasoningEffort: requested,
  });
  for (const options of malformed)
    for (const requested of efforts) {
      const broken = bad(options);
      reason([broken], requested);
      reason([broken, a], requested);
      reason([a, broken], requested);
      for (const custom of [false, true])
        route({
          configuration: configuration(requested, custom),
          rootRuntimes: [broken],
          subagentRuntimes: [a],
        });
      route({
        configuration: {
          ...configuration("high", true),
          subagentReasoningEffort: requested,
        },
        rootRuntimes: [a],
        subagentRuntimes: [broken],
      });
      route({
        configuration: configuration(requested),
        rootRuntimes: [broken],
        subagentRuntimes: [],
        workerConnected: false,
      });
      route({
        configuration: configuration(requested, true),
        rootRuntimes: [broken],
        subagentRuntimes: [c],
      });
    }
  for (let i = 0; i < 1000; i++) {
    const roots = Array.from({ length: random(4) }, () =>
      bad(malformed[random(malformed.length)]),
    );
    const subs = Array.from({ length: random(4) }, () =>
      bad(malformed[random(malformed.length)]),
    );
    const requested = efforts[random(efforts.length)];
    reason(roots, requested);
    route({
      configuration: {
        ...configuration(requested, Boolean(random(2))),
        subagentReasoningEffort: efforts[random(efforts.length)],
      },
      rootRuntimes: roots,
      subagentRuntimes: subs,
    });
  }
}
