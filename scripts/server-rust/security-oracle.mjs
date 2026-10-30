// Only development tests invoke this process. Expectations execute the actual
// exported protocol schemas, not the native manifest or its interpreter.
import * as protocol from "../../packages/protocol/dist/index.js";
import { buildContractManifest, sourceContractSchema } from "./contracts.mjs";
import { securityFixtures } from "./security-fixtures.mjs";
import { usageQueryCases } from "./usage-wire-fixtures.mjs";
import { settingsWireCases } from "./settings-wire-fixtures.mjs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export function outcome(schema, input) {
  try {
    const parsed = schema.safeParse(input);
    return parsed.success
      ? { ok: parsed.data }
      : { issues: parsed.error.issues };
  } catch (error) {
    return { thrown: error.name };
  }
}
function paths(value, prefix = [], result = []) {
  if (value && typeof value === "object")
    for (const [key, child] of Object.entries(value)) {
      const path = [...prefix, Array.isArray(value) ? +key : key];
      result.push(path);
      paths(child, path, result);
    }
  return result;
}
function mutate(input, path, value, remove = false) {
  const result = structuredClone(input);
  let parent = result;
  for (const key of path.slice(0, -1)) parent = parent[key];
  const key = path.at(-1);
  if (remove) {
    if (Array.isArray(parent)) parent.splice(key, 1);
    else delete parent[key];
  } else parent[key] = value;
  return result;
}
export function* vectorCases(name, samples = securityFixtures[name]) {
  const schema = sourceContractSchema(name);
  if (!schema || !samples) throw new Error(`Missing oracle fixture ${name}`);
  function prepare(input, present = true) {
    const canonical = present ? JSON.parse(JSON.stringify(input)) : undefined;
    const result = outcome(schema, canonical);
    return {
      ...(present ? { input: canonical } : {}),
      outcome: result,
      ...(result.issues
        ? { errorMessage: schema.safeParse(canonical).error.message }
        : {}),
    };
  }
  yield prepare(undefined, false);
  for (const input of usageQueryCases(name)) yield prepare(input);
  for (const input of settingsWireCases(name)) yield prepare(input);
  for (const input of [null, [], {}, false, 42, ""]) yield prepare(input);
  for (const sample of samples) {
    const baseline = schema.parse(sample);
    yield prepare(sample);
    yield prepare(baseline);
    const variants = [
      null,
      false,
      true,
      0,
      -1,
      1.5,
      2147483648,
      9007199254740992,
      "",
      " ",
      "bad\nvalue",
      [],
      {},
      { length: 0 },
      { length: "0x10" },
      { length: [] },
      { length: { toString: null } },
    ];
    for (const path of paths(baseline)) {
      yield prepare(mutate(baseline, path, null, true));
      for (const value of variants)
        yield prepare(mutate(baseline, path, value));
      const original = path.reduce((value, key) => value[key], baseline);
      if (Array.isArray(original) && original.length > 0)
        yield prepare(mutate(baseline, path, [...original, ...original]));
      if (typeof original === "string") {
        for (const value of [
          "🦀",
          "\ufeff  fixture  \ufeff",
          "a".repeat(513),
          original + "\n",
          original + "=",
          original.slice(0, -1) + "B",
        ])
          yield prepare(mutate(baseline, path, value));
      }
      if (
        original &&
        typeof original === "object" &&
        !Array.isArray(original)
      ) {
        yield prepare(
          mutate(baseline, path, { ...original, unknownFixture: true }),
        );
        yield prepare(
          mutate(baseline, path, {
            ...original,
            ["unknown\ud800Fixture"]: true,
            ["\udfff"]: false,
          }),
        );
      }
    }
    if (baseline && typeof baseline === "object" && !Array.isArray(baseline)) {
      yield prepare({ ...baseline, unknownFixture: true });
      yield prepare({
        ...baseline,
        ["unknown\ud800Fixture"]: true,
        ["\udfff"]: false,
      });
    }
  }
}
export function vectors(name) {
  return { schema: name, cases: [...vectorCases(name)] };
}

function jsonVectors() {
  const raw = [
    "null",
    "true",
    "false",
    "-0",
    "0.0",
    "1e999",
    "-1e999",
    "1e-999",
    "9007199254740993",
    "1000000000000000128",
    "1e-7",
    "1e-6",
    "1e20",
    "1e21",
    '{"z":0,"10":10,"2":2,"a":1,"0":0,"01":1,"4294967294":4,"4294967295":5,"z":2}',
    '{"\\ud800":"\\udfff","\\ud800":"second","😀":"pair","1":"index"}',
    '["\\ud800","\\udfff","\\ud800\\udfff","\\udfff\\ud800","\\u0000","\\u2028","\\u2029","\\ud800x\\udfff"]',
    '{"empty":{},"array":[],"nested":[{},[],{"quote":"\\\"\\\\,[]:{}","value":true}],"after":null}',
  ];
  for (let unit = 0; unit <= 65535; unit++)
    raw.push(`"\\u${unit.toString(16).padStart(4, "0")}"`);
  const bytes = new ArrayBuffer(8),
    view = new DataView(bytes);
  let state = 0x1ba5e;
  for (let i = 0; i < 4096; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    view.setUint32(0, state);
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    view.setUint32(4, state);
    const number = view.getFloat64(0);
    if (Number.isFinite(number)) raw.push(number.toExponential(17));
  }
  return raw.map((raw) => ({
    raw,
    expected: JSON.stringify(JSON.parse(raw)),
    expectedPretty: JSON.stringify(JSON.parse(raw), null, 2),
  }));
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv.includes("--json-vectors"))
    process.stdout.write(JSON.stringify(jsonVectors()));
  else if (process.argv.includes("--fixtures"))
    process.stdout.write(JSON.stringify(securityFixtures));
  else if (process.argv.includes("--manifest"))
    process.stdout.write(JSON.stringify(buildContractManifest()));
  else if (process.argv.includes("--vectors"))
    process.stdout.write(JSON.stringify(vectors(process.argv.at(-1))));
  else {
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    process.stdout.write(
      JSON.stringify(
        JSON.parse(input).map(({ schema, input }) =>
          outcome(protocol[schema], input),
        ),
      ),
    );
  }
}
