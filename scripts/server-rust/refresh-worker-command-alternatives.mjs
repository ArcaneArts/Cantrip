// Refresh coverage from current schemas without discarding historical cases.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import * as p from "../../packages/protocol/dist/index.js";
import { securityFixtures } from "./security-fixtures.mjs";
import { currentWorkerCommandFixtures } from "./current-worker-command-fixtures.mjs";
import {
  workerCommandAlternatives,
  workerCommandAlternativePath,
  validateAlternatives,
} from "./worker-command-coverage.mjs";

const url = new URL("./worker-command-alternatives.json", import.meta.url);
const fixtures = JSON.parse(await readFile(url, "utf8"));
const originalCount = fixtures.cases.length;
const casesByJson = new Map(
  fixtures.cases.map(({ input }, i) => [JSON.stringify(input), i]),
);
const valid = new Map();
function isValid(input) {
  if (!valid.has(input))
    valid.set(input, p.workerRequestEnvelopeSchema.safeParse(input).success);
  return valid.get(input);
}
function add(input, name) {
  const key = JSON.stringify(input);
  if (!casesByJson.has(key)) {
    casesByJson.set(key, fixtures.cases.length);
    fixtures.cases.push({ name, input });
  }
  return casesByJson.get(key);
}
for (const { command } of securityFixtures.workerRequestEnvelopeSchema)
  add(
    { kind: "request", requestId: "fixture-command", command },
    `current-${command.type}`,
  );
for (const command of currentWorkerCommandFixtures(securityFixtures))
  add(
    { kind: "request", requestId: "fixture-command", command },
    `current-${command.type}`,
  );

const get = (input, path) => path.reduce((value, key) => value?.[key], input);
function replace(input, path, value) {
  if (!path.length) return structuredClone(value);
  const copy = structuredClone(input);
  let target = copy;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    if (target[key] === null || typeof target[key] !== "object")
      target[key] = typeof path[i + 1] === "number" ? [] : {};
    target = target[key];
  }
  target[path.at(-1)] = structuredClone(value);
  return copy;
}

// Candidate values come from existing domain examples. They are never treated
// as valid until the actual option and full enclosing request have parsed them.
const values = new Map();
function collect(value) {
  if (value === undefined) return;
  const key = JSON.stringify(value);
  if (key.length <= 8192) values.set(key, value);
  if (value && typeof value === "object")
    for (const child of Object.values(value)) collect(child);
}
for (const samples of Object.values(securityFixtures))
  for (const sample of samples.slice(0, 4)) collect(sample);
for (const { input } of fixtures.cases) collect(input);

const alternatives = [];
for (const { kind, path, index, schema } of workerCommandAlternatives()) {
  const { valuePath } = workerCommandAlternativePath(path);
  const option = kind === "union" ? schema.options[index] : null;
  const enumValue =
    kind === "enum" ? Object.values(schema._zod.def.entries)[index] : undefined;
  let match = fixtures.cases.findIndex(({ input }) => {
    const value = get(input, valuePath);
    return kind === "enum"
      ? value === enumValue
      : option.safeParse(value).success && isValid(input);
  });
  if (match === -1) {
    const enclosingType =
      path[0] === "command" && path[1] === "options"
        ? p.workerCommandSchema.options[Number(path[2])].shape.type.value
        : null;
    const bases = fixtures.cases.filter(
      ({ input }) =>
        (!enclosingType || input.command.type === enclosingType) &&
        isValid(input),
    );
    const candidates =
      kind === "enum"
        ? [enumValue]
        : [...values.values()].filter(
            (value) => option.safeParse(value).success,
          );
    search: for (const { input } of bases) {
      for (const value of candidates) {
        const candidate = replace(input, valuePath, value);
        // An enum may intentionally fail an enclosing semantic refinement;
        // the comparison oracle records that actual rejection, as before.
        if (kind === "enum" || isValid(candidate)) {
          match = add(candidate, `current-alternative-${alternatives.length}`);
          break search;
        }
      }
    }
  }
  assert.notEqual(
    match,
    -1,
    `Add a full domain example for ${kind} ${JSON.stringify(path)} option ${index}`,
  );
  alternatives.push({ kind, path, index, case: match });
}
fixtures.alternatives = alternatives;
const { coverage } = validateAlternatives(fixtures);
await writeFile(url, JSON.stringify(fixtures, null, 2) + "\n");
console.log(
  JSON.stringify({
    ...coverage,
    cases: fixtures.cases.length,
    preservedCases: originalCount,
  }),
);
