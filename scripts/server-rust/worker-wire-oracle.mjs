// Development-only expectations execute the authoritative protocol directly.
import {
  agentInteractionRequestPayloadSchema,
  agentInteractionResponseSchema,
  workerServerEnvelopeSchema,
} from "../../packages/protocol/dist/index.js";
import { outcome, vectors } from "./security-oracle.mjs";
import { workerIngressFixtures } from "./worker-wire-fixtures.mjs";
import refinements from "./worker-wire-refinement-fixtures.json" with { type: "json" };
import variants from "./worker-wire-variant-fixtures.json" with { type: "json" };

function replace(input, path, value) {
  const result = structuredClone(input);
  const parent = path.slice(0, -1).reduce((node, key) => node[key], result);
  parent[path.at(-1)] = value;
  return result;
}
const at = (input, path) => path.reduce((value, key) => value[key], input);

function workerVectors() {
  const cases = vectors("workerServerEnvelopeSchema").cases.map(
    (item, index) => ({
      name: "mutation-" + index,
      ...(Object.hasOwn(item, "input")
        ? { raw: JSON.stringify(item.input) }
        : {}),
      outcome: item.outcome,
    }),
  );
  function append(name, raw) {
    cases.push({
      name,
      raw,
      outcome: outcome(workerServerEnvelopeSchema, JSON.parse(raw)),
    });
  }
  const appendInput = (name, input) => append(name, JSON.stringify(input));
  for (const variant of variants.cases) {
    workerServerEnvelopeSchema.parse(variant.input);
    appendInput("union/" + variant.path, variant.input);
  }
  function enumMutations(schema, value, path, root, name) {
    const def = schema._zod.def;
    if (def.type === "enum" || def.type === "literal") {
      for (const alternative of new Set(
        def.values ?? Object.values(def.entries),
      ))
        if (!Object.is(alternative, value))
          appendInput(
            name +
              "/enum/" +
              JSON.stringify(path) +
              "/" +
              JSON.stringify(alternative),
            replace(root, path, alternative),
          );
    } else if (["optional", "nullable", "default"].includes(def.type)) {
      if (value !== null && value !== undefined)
        enumMutations(def.innerType, value, path, root, name);
    } else if (def.type === "lazy") {
      enumMutations(def.getter(), value, path, root, name);
    } else if (def.type === "union") {
      const selected = def.options.find(
        (option) => option.safeParse(value).success,
      );
      if (!selected)
        throw new Error("Accepted enum fixture lost its union branch.");
      enumMutations(selected, value, path, root, name);
    } else if (def.type === "object") {
      for (const [key, child] of Object.entries(def.shape))
        if (Object.hasOwn(value, key))
          enumMutations(child, value[key], [...path, key], root, name);
    } else if (def.type === "array") {
      value.forEach((child, index) =>
        enumMutations(def.element, child, [...path, index], root, name),
      );
    } else if (def.type === "record") {
      for (const [key, child] of Object.entries(value))
        enumMutations(def.valueType, child, [...path, key], root, name);
    } else if (def.type === "pipe") {
      enumMutations(def.in, value, path, root, name);
    }
  }
  for (const [index, sample] of workerIngressFixtures.entries()) {
    const normalized = workerServerEnvelopeSchema.parse(sample);
    enumMutations(
      workerServerEnvelopeSchema,
      normalized,
      [],
      normalized,
      "fixture-" + index,
    );
    const pending = [[sample, []]];
    while (pending.length) {
      const [value, path] = pending.pop();
      if (!value || typeof value !== "object") continue;
      if (!Array.isArray(value)) {
        const input = structuredClone(sample);
        const target = path.reduce((node, key) => node[key], input);
        Object.defineProperty(target, "__proto__", {
          value: false,
          enumerable: true,
        });
        append(
          "prototype/" + index + "/" + JSON.stringify(path),
          JSON.stringify(input),
        );
      }
      for (const [key, child] of Object.entries(value))
        pending.push([child, [...path, key]]);
    }
  }
  append(
    "unknown-result-prototype-and-nonfinite",
    '{"kind":"response","requestId":"fixture","ok":true,"result":{"__proto__":1e400,"constructor":1}}',
  );
  append(
    "ignored-deep-prototype",
    '{"kind":"response","requestId":"fixture","ok":true,"result":null,"__proto__":' +
      "[".repeat(8192) +
      "1e400" +
      "]".repeat(8192) +
      "}",
  );
  const target = (check) => {
    const entry = refinements.cases.find((entry) => entry.check === check);
    const input = refinements.fixtures[entry.fixture];
    return { input, path: entry.path, value: at(input, entry.path) };
  };
  const mutateTarget = (check, name, value) => {
    const { input, path } = target(check);
    appendInput(
      "refinement-" + check + "/" + name,
      replace(input, path, value),
    );
  };
  for (const check of [7, 26])
    for (const [name, value] of [
      ["utf8-exact", "😀".repeat(64)],
      ["utf8-over", "a".repeat(257)],
      ["codepoints-over", "a".repeat(65)],
      ["surrogates", "\ud800".repeat(64)],
      ["control", "id\u0080"],
      ["format-character", "id\u200d"],
    ])
      mutateTarget(check, name, value);
  for (const [check, limit] of [
    [20, 262144],
    [21, 65536],
    [22, 262144],
  ])
    for (const [name, value] of [
      ["ascii-exact", "a".repeat(limit)],
      ["ascii-over", "a".repeat(limit + 1)],
      ["surrogates-over", "\ud800".repeat(Math.floor(limit / 3) + 1)],
    ])
      mutateTarget(check, name, value);
  for (const count of [32, 33]) {
    const metadata = Object.fromEntries(
      Array.from({ length: count }, (_, index) => ["key" + index, "value"]),
    );
    Object.defineProperty(metadata, "__proto__", {
      value: false,
      enumerable: true,
    });
    mutateTarget(19, "metadata-" + count, metadata);
  }
  for (const width of [2048, 2049]) {
    const { value } = target(24);
    mutateTarget(24, "image-" + width, { ...value, width, height: 2048 });
  }
  for (const path of [
    "a/../b",
    "a\\..\\b",
    "C:\\root",
    "C:relative",
    "\\root",
    "a/",
    "a\0b",
    "🦀/\ud800",
  ])
    mutateTarget(3, "path-" + JSON.stringify(path), path);
  for (const [startedAt, observedAt] of [
    ["2026-02-30T00:00:00Z", "2026-03-01T00:00:00Z"],
    ["2026-10-25T24:00Z", "2026-10-25T23:59Z"],
    ["1", "2000-01-01T00:00Z"],
    ["2026-10-25", "2026-10-24T00:00Z"],
    ["10/25/2026", "2026-10-24T00:00Z"],
    ["2026-10-25T00:00:00+01:00", "2026-10-24T22:30Z"],
    ["2026-10-25T00:00:00-00:01", "2026-10-25T00:00Z"],
    ["2026-10-25T00:00:00.123456789Z", "2026-10-25T00:00:00.123Z"],
  ]) {
    const { value } = target(18);
    mutateTarget(18, "date-" + startedAt, { ...value, startedAt, observedAt });
  }
  {
    const { input, path, value } = target(11);
    const empty = {
      ...value,
      response: {
        kind: "permissions",
        permissions: "",
        scope: "turn",
        strictAutoReview: false,
      },
    };
    const normalized = workerServerEnvelopeSchema.parse(
      replace(input, path, empty),
    );
    const padding = 1_000_000 - JSON.stringify(at(normalized, path)).length;
    for (const [name, content] of [
      ["ascii-exact", "a".repeat(padding)],
      ["ascii-over", "a".repeat(padding + 1)],
      [
        "utf16-exact",
        "🦀".repeat(Math.floor(padding / 2)) + "a".repeat(padding % 2),
      ],
      [
        "utf16-over",
        "🦀".repeat(Math.floor(padding / 2)) + "a".repeat((padding % 2) + 1),
      ],
    ])
      mutateTarget(11, "storage-" + name, {
        ...empty,
        response: { ...empty.response, permissions: content },
      });
  }
  for (const [check, key] of [
    [9, "protectedResponse"],
    [30, "protectedPayload"],
  ]) {
    const { value } = target(check);
    mutateTarget(check, "storage-over", {
      ...value,
      [key]: {
        ...value[key],
        envelope: { ...value[key].envelope, ciphertext: "A".repeat(1_000_000) },
      },
    });
  }
  {
    const { value } = target(29);
    const provenance = {
      ...value.provenance,
      owner: "computer-use",
      chatId: "fixture-chat",
      threadId: null,
    };
    for (const kind of ["permissions", "commandExecution"])
      mutateTarget(29, "owner-" + kind, {
        ...value,
        provenance,
        classification: { ...value.classification, kind },
      });
  }
  {
    const { value } = target(13);
    mutateTarget(13, "missing-cwd", { ...value, cwd: null });
    mutateTarget(13, "native-cwd", {
      ...value,
      cwd: null,
      source: "native-computer-use",
    });
  }
  return cases;
}

function jsonVectors() {
  const schema = agentInteractionResponseSchema.options.find(
    (option) => option.shape.kind.value === "permissions",
  ).shape.permissions;
  const permission = {
    kind: "permissions",
    startedAtMs: 1,
    environmentId: null,
    cwd: "/fixture",
    reason: null,
  };
  const cases = [];
  function append(name, raw) {
    const input = raw === undefined ? undefined : JSON.parse(raw);
    const parsed = schema.safeParse(input);
    const nested = agentInteractionRequestPayloadSchema.safeParse({
      ...permission,
      ...(raw === undefined ? {} : { requestedPermissions: input }),
    });
    cases.push({
      name,
      ...(raw === undefined ? {} : { raw }),
      outcome: parsed.success
        ? { ok: parsed.data }
        : { issues: parsed.error.issues },
      nestedOutcome: nested.success
        ? { ok: nested.data.requestedPermissions }
        : { issues: nested.error.issues },
    });
  }
  append("missing");
  for (const [name, raw] of [
    ["ordinary", '{"a":1,"nested":[true,null,"x"]}'],
    ["prototype-key", '{"__proto__":{"x":1},"safe":2}'],
    ["nested-prototype-key", '[{"__proto__":{"x":1},"safe":2}]'],
    ["constructor-key", '{"constructor":{"prototype":{"x":1}},"safe":2}'],
    ["prototype-name", '{"prototype":{"x":1},"safe":2}'],
    ["duplicate-key", '{"a":1,"a":2,"__proto__":0,"__proto__":3}'],
    ["numeric-key-order", '{"10":10,"2":2,"01":1,"4294967295":5,"0":0}'],
    ["lone-surrogates", '{"\\ud800":"\\udfff","value":"\\ud800x"}'],
    ["nonfinite", "1e400"],
    ["nested-nonfinite", '{"a":[1e400]}'],
    ["ignored-prototype-nonfinite", '{"__proto__":1e400,"safe":2}'],
    [
      "ignored-prototype-deep",
      '{"__proto__":' +
        "[".repeat(8192) +
        "0" +
        "]".repeat(8192) +
        ',"safe":2}',
    ],
    ["multiple-array-errors", '[1e400,-1e400,{"a":1e400}]'],
    ["numeric-key-issue-order", '{"10":1e400,"2":1e400,"a":1e400,"1":1e400}'],
    [
      "prototype-skipped-with-other-errors",
      '{"__proto__":[1e400],"constructor":{"prototype":1e400},"safe":1e400}',
    ],
    ["nested-array-record-errors", '{"a":[{"b":[1e400]},-1e400]}'],
  ])
    append(name, raw);

  let state = 0x6d2b79f5;
  function random(max) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % max;
  }
  const strings = [
    "",
    "a",
    "__proto__",
    "constructor",
    "prototype",
    "\ud800",
    "\udfff",
    "\ud800x",
    "\u0000",
    "😀",
    "2",
    "01",
    "4294967295",
    "4294967294",
  ];
  const scalars = [
    "null",
    "true",
    "false",
    "0",
    "-0",
    "1.5",
    "5e-324",
    "1.7976931348623157e308",
    "1e400",
    "-1e400",
    ...strings.map((text) => JSON.stringify(text)),
  ];
  function rawValue(depth = 0) {
    const kind = depth >= 6 ? 0 : random(4);
    if (kind === 0) return scalars[random(scalars.length)];
    if (kind === 1)
      return (
        "[" +
        Array.from({ length: random(5) }, () => rawValue(depth + 1)).join(",") +
        "]"
      );
    return (
      "{" +
      Array.from(
        { length: random(5) },
        () =>
          JSON.stringify(strings[random(strings.length)]) +
          ":" +
          rawValue(depth + 1),
      ).join(",") +
      "}"
    );
  }
  for (let index = 0; index < 4096; index++)
    append("generated-" + index, rawValue());
  append("subsequent-valid-input", '{"safe":[1,true,null]}');
  return cases;
}

function dateVectors() {
  const inputs = new Set([
    "",
    " ",
    "invalid",
    "1",
    "0",
    "31",
    "32",
    "49",
    "50",
    "99",
    "2026",
    "2026 ",
    "Jan 3",
    "Jan 2026",
    "garbage Jan 3 2026",
    "-000000-01-01",
    "+000000-01-01",
    "+275760-09-13T00:00:00Z",
    "+275760-09-13T00:00:00.001Z",
    "-271821-04-20T00:00:00Z",
    "-271821-04-19T23:59:59.999Z",
    "+275760-09-12T00:00",
    "-271821-04-21T00:00",
    "-100000-07-01T12:00",
    "+100000-07-01T12:00",
    "-000001-07-01T12:00",
    "1860-07-01T12:00",
    "2100-07-01T12:00",
    "2800-07-01T12:00",
    "9999-12-31T24:00",
    "2026-10-25T00:00Z\0ignored",
    "2026-10-25T24:00:00.0009Z",
    "2026-03-08T02:30",
    "2026-11-01T01:30",
    "2026-03-29T02:30",
    "2026-10-25T02:30",
    "2011-12-30T12:00",
  ]);
  const pad = (value, width = 2) => String(value).padStart(width, "0");
  for (const year of [0, 1, 49, 50, 99, 100, 1900, 2000, 2024, 2026, 9999])
    for (const month of [0, 1, 2, 3, 4, 6, 9, 12, 13])
      for (const day of [0, 1, 28, 29, 30, 31, 32])
        for (const hour of [0, 23, 24, 25])
          inputs.add(
            pad(year, 4) +
              "-" +
              pad(month) +
              "-" +
              pad(day) +
              "T" +
              pad(hour) +
              ":00:00Z",
          );
  for (const year of [0, 1, 31, 32, 49, 50, 69, 99, 100, 2000, 2026, 9999])
    for (const month of [1, 2, 10, 12])
      for (const day of [1, 28, 31])
        for (const separator of ["/", "-", ".", " ", "?"]) {
          inputs.add([year, month, day].join(separator));
          inputs.add([month, day, year].join(separator));
        }
  for (const fraction of [
    "0",
    "1",
    "12",
    "123",
    "0001",
    "000000123456789012",
    "0000000012",
    "123456789123456789",
    "0".repeat(10000) + "1",
  ])
    for (const hour of ["00", "24"])
      inputs.add("2026-10-25T" + hour + ":00:00." + fraction + "Z");
  for (const prefix of [
    "",
    "Monday ",
    "garbage ",
    "Jan",
    "January ",
    "JanXYZ ",
    "Sunday ",
    "\ud800 ",
    "\u2028",
    "\u00a0",
    "\ufeff",
  ])
    for (const suffix of [
      "",
      "Z",
      " GMT",
      " UTC",
      " EST",
      " PST",
      " GMT+8",
      " GMT+0800",
      " GMT-1:02",
      " GMT+999999999:0",
      " GMT+12345",
      " (comment)",
      "(comment)",
      " (unclosed",
    ])
      inputs.add(prefix + "1 2026 12:30" + suffix);
  for (const separator of ["T", "t", " ", "\t", "_"])
    for (const suffix of [
      "",
      "Z",
      "z",
      "+01:00",
      "-00:01",
      "+0100",
      "+24:00",
      "Z ",
      "Z\0extra",
    ])
      inputs.add("2026-10-25" + separator + "12:30:59" + suffix);
  return [...inputs].map((input) => ({
    input,
    millis: Number.isNaN(Date.parse(input)) ? null : Date.parse(input),
  }));
}

if (process.argv.includes("--json-vectors"))
  process.stdout.write(JSON.stringify(jsonVectors()));
else if (process.argv.includes("--worker-vectors"))
  process.stdout.write(JSON.stringify(workerVectors()));
else if (process.argv.includes("--date-vectors"))
  process.stdout.write(JSON.stringify(dateVectors()));
else throw new Error("A worker wire oracle mode is required.");
