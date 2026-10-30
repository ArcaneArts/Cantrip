// Expectations execute the authoritative protocol. Output is streamed so the
// native comparison does not need to retain the entire mutation corpus.
import assert from "node:assert/strict";
import { once } from "node:events";
import * as protocol from "../../packages/protocol/dist/index.js";
import fixtures from "./worker-command-fixtures.json" with { type: "json" };
import refinements from "./worker-command-refinement-fixtures.json" with { type: "json" };
import alternatives from "./worker-command-alternatives.json" with { type: "json" };
import { validateAlternatives } from "./worker-command-coverage.mjs";
import { commandBoundaries } from "./worker-command-boundaries.mjs";
import { registerWorkerCommandContracts } from "./worker-command-contracts.mjs";
import { outcome, vectorCases } from "./security-oracle.mjs";

assert.deepEqual(
  fixtures.commands.map((c) => c.type),
  protocol.workerCommandSchema.options.map((s) => s.shape.type.value),
);
for (const item of fixtures.commands)
  protocol.workerRequestEnvelopeSchema.parse(item.input);
for (const item of refinements.cases)
  protocol.workerRequestEnvelopeSchema.parse(item.input);
const { unionInputs, coverage } = validateAlternatives(alternatives);
const knownInputs = new Set(
  [...fixtures.commands, ...refinements.cases].map((item) =>
    JSON.stringify(item.input),
  ),
);
const additionalUnionInputs = [...unionInputs]
  .filter(([key]) => !knownInputs.has(key))
  .map(([, input]) => input);
// Count actual authoritative callbacks while producing the cases. This is a
// post-run coverage receipt, not an inferred list of supported features.
const seen = new Set(),
  checks = new Set();
registerWorkerCommandContracts((schema, index) => {
  const check = schema._zod.def.checks.filter(
    (c) => c._zod.def.check === "custom",
  )[index];
  if (checks.has(check)) return;
  checks.add(check);
  const original = check._zod.check;
  check._zod.check = function (...args) {
    seen.add(check);
    return original.apply(this, args);
  };
});
const smoke = process.argv.includes("--smoke");
const boundaries = process.argv.includes("--boundaries");
function* mutations() {
  for (const item of alternatives.cases)
    yield {
      input: item.input,
      outcome: outcome(protocol.workerRequestEnvelopeSchema, item.input),
    };
  yield* vectorCases("workerRequestEnvelopeSchema");
  yield* vectorCases("workerRequestEnvelopeSchema", additionalUnionInputs);
}
const cases = boundaries
  ? (function* () {
      for (const item of commandBoundaries()) {
        const input = Object.hasOwn(item, "raw")
          ? JSON.parse(item.raw)
          : item.input;
        yield {
          ...item,
          outcome: outcome(protocol.workerRequestEnvelopeSchema, input),
        };
      }
    })()
  : smoke
    ? fixtures.commands.map((item) => ({
        input: item.input,
        outcome: outcome(protocol.workerRequestEnvelopeSchema, item.input),
      }))
    : mutations();
async function emit(value) {
  if (!process.stdout.write(JSON.stringify(value) + "\n"))
    await once(process.stdout, "drain");
}
let count = 0;
for (const item of cases) {
  const index = count++;
  await emit({
    name:
      item.name ??
      (smoke ? fixtures.commands[index].type : "mutation-" + index),
    ...(Object.hasOwn(item, "raw")
      ? { raw: item.raw }
      : Object.hasOwn(item, "input")
        ? { raw: JSON.stringify(item.input) }
        : {}),
    outcome: item.outcome,
  });
}
await emit({
  done: count,
  commandTypes: fixtures.commands.length,
  mode: boundaries ? "boundaries" : smoke ? "fixtures" : "mutations",
  customChecksExecuted: seen.size,
  customChecks: checks.size,
  ...(smoke || boundaries ? {} : coverage),
});
