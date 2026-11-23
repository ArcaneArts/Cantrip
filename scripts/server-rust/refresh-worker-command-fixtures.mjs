// Development utility: retain existing examples and add current domain seeds.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import * as p from "../../packages/protocol/dist/index.js";
import { securityFixtures } from "./security-fixtures.mjs";
import { currentWorkerCommandFixtures } from "./current-worker-command-fixtures.mjs";

const url = new URL("./worker-command-fixtures.json", import.meta.url);
const fixtures = JSON.parse(await readFile(url, "utf8"));
const existing = new Map(fixtures.commands.map((item) => [item.type, item]));
const candidates = currentWorkerCommandFixtures(securityFixtures);
const currentTypes = p.workerCommandSchema.options.map(
  (schema) => schema.shape.type.value,
);
for (const type of currentTypes) {
  if (!existing.has(type)) {
    const command = candidates.find((candidate) => candidate.type === type);
    assert.ok(command, `Add a domain fixture for ${type}`);
    const input = { kind: "request", requestId: "fixture-command", command };
    p.workerRequestEnvelopeSchema.parse(input);
    existing.set(type, { type, input });
  }
}
assert.deepEqual(
  [...existing.keys()].filter((type) => !currentTypes.includes(type)),
  [],
);
fixtures.commands = currentTypes.map((type) => existing.get(type));
for (const { input } of fixtures.commands)
  p.workerRequestEnvelopeSchema.parse(input);
await writeFile(url, JSON.stringify(fixtures, null, 2) + "\n");
console.log(
  `${fixtures.commands.length} current command fixtures validated and saved.`,
);
