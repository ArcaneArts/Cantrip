// Development-only coverage against actual protocol schemas and full inputs.
import assert from "node:assert/strict";
import * as protocol from "../../packages/protocol/dist/index.js";

export function validateAlternatives(fixtures) {
  const seen = new Set(),
    expected = [];
  function visit(schema, path) {
    if (seen.has(schema)) return;
    seen.add(schema);
    const d = schema._zod.def;
    if (d.type === "union" || d.type === "enum") {
      const values = d.type === "union" ? d.options : Object.values(d.entries);
      values.forEach((_, index) =>
        expected.push({ kind: d.type, path, index }),
      );
    }
    if (d.shape)
      for (const [key, child] of Object.entries(d.shape))
        visit(child, [...path, key]);
    for (const key of [
      "innerType",
      "element",
      "keyType",
      "valueType",
      "catchall",
      "in",
      "out",
      "rest",
    ])
      if (d[key]?._zod) visit(d[key], [...path, key]);
    for (const key of ["options", "items"])
      if (Array.isArray(d[key]))
        d[key].forEach((child, i) => visit(child, [...path, key, String(i)]));
    if (d.getter) visit(d.getter(), [...path, "resolved"]);
  }
  visit(protocol.workerRequestEnvelopeSchema, []);
  assert.deepEqual(
    fixtures.alternatives.map(({ kind, path, index }) => ({
      kind,
      path,
      index,
    })),
    expected,
  );
  const unionInputs = new Map();
  for (const { kind, path, index, case: fixture } of fixtures.alternatives) {
    const input = fixtures.cases[fixture].input;
    let schema = protocol.workerRequestEnvelopeSchema,
      value = input;
    for (let i = 0; i < path.length; i++) {
      const token = path[i],
        d = schema._zod.def;
      if (d.shape && Object.hasOwn(d.shape, token)) {
        schema = d.shape[token];
        value = value[token];
      } else if (["innerType", "in", "out"].includes(token)) schema = d[token];
      else if (token === "resolved") schema = d.getter();
      else if (token === "options") schema = d.options[Number(path[++i])];
      else if (token === "items") {
        const key = Number(path[++i]);
        schema = d.items[key];
        value = value[key];
      } else if (token === "element") {
        schema = d.element;
        value = value[0];
      } else if (token === "valueType") {
        schema = d.valueType;
        value = value.fixture;
      } else throw new Error("Unknown alternative fixture path: " + token);
    }
    assert.equal(schema._zod.def.type, kind);
    if (kind === "union") {
      schema.options[index].parse(value);
      protocol.workerRequestEnvelopeSchema.parse(input);
      unionInputs.set(JSON.stringify(input), input);
    } else assert.equal(value, Object.values(schema._zod.def.entries)[index]);
  }
  return {
    unionInputs,
    coverage: Object.fromEntries(
      ["union", "enum"].flatMap((kind) => [
        [
          kind + "Schemas",
          new Set(
            expected
              .filter((item) => item.kind === kind)
              .map((item) => item.path.join("/")),
          ).size,
        ],
        [
          kind + "Alternatives",
          expected.filter((item) => item.kind === kind).length,
        ],
      ]),
    ),
  };
}
