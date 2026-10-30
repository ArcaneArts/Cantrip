// Stream large boundary inputs individually; expectations execute the protocol.
import assert from "node:assert/strict";
import * as protocol from "../../packages/protocol/dist/index.js";
import refinements from "./worker-command-refinement-fixtures.json" with { type: "json" };
import alternatives from "./worker-command-alternatives.json" with { type: "json" };

function locate(input, tokens) {
  let schema = protocol.workerRequestEnvelopeSchema,
    value = input;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i],
      d = schema._zod.def;
    if (d.shape && Object.hasOwn(d.shape, token)) {
      schema = d.shape[token];
      value = value[token];
    } else if (token === "innerType") schema = d.innerType;
    else if (token === "options") schema = d.options[Number(tokens[++i])];
    else if (token === "element") {
      schema = d.element;
      value = value[0];
    } else throw new Error("Unsupported boundary fixture path: " + token);
  }
  return value;
}

export function* commandBoundaries() {
  for (const check of refinements.checks) {
    if (!/^worker-command-(protected-bytes|control-content):/.test(check.tag))
      continue;
    const max = Math.ceil(((Number(check.tag.split(":")[1]) + 16) * 4) / 3);
    for (const delta of [-1, 0, 1]) {
      const input = structuredClone(refinements.cases[check.fixture].input);
      locate(input, check.schemaPath.split("/").slice(1)).envelope.ciphertext =
        "A".repeat(max + delta);
      yield { name: check.tag + ":" + delta, input };
    }
  }
  for (const check of refinements.checks.filter(
    (check) => check.tag === "worker-command-run-document",
  )) {
    for (const unicode of [false, true])
      for (const delta of [-1, 0, 1]) {
        const input = structuredClone(refinements.cases[check.fixture].input);
        const document = locate(input, check.schemaPath.split("/").slice(1));
        document.arguments = Array(31)
          .fill(unicode ? "🦀".repeat(4096) : "A".repeat(16384))
          .concat("");
        const remaining =
          524288 + delta - Buffer.byteLength(JSON.stringify(document));
        assert(remaining >= 0 && remaining <= 16384);
        document.arguments[31] = "A".repeat(remaining);
        assert.equal(
          Buffer.byteLength(JSON.stringify(document)),
          524288 + delta,
        );
        yield {
          name:
            "run-document:" + document.provider + ":" + unicode + ":" + delta,
          input,
        };
      }
  }
  const structured = alternatives.cases.find(
    (item) => item.input.command.resultMode?.kind === "structured",
  ).input;
  function objectCase(name, value) {
    const input = structuredClone(structured);
    input.command.resultMode.outputSchema = value;
    return { name: "bounded-json:" + name, input };
  }
  for (const size of [99999, 100000, 100001]) {
    yield objectCase("string:" + size, { value: "A".repeat(size) });
    yield objectCase("utf16-string:" + size, {
      value: "🦀".repeat(Math.floor(size / 2)) + (size % 2 ? "A" : ""),
    });
  }
  for (const size of [999, 1000, 1001]) {
    yield objectCase("array:" + size, { value: Array(size).fill(null) });
    yield objectCase("keys:" + size, {
      value: Object.fromEntries(
        Array.from({ length: size }, (_, i) => ["k" + i, null]),
      ),
    });
  }
  for (const size of [0, 1, 256, 257])
    yield objectCase("key:" + size, { ["k".repeat(size)]: 0 });
  for (const size of [31, 32, 33]) {
    let value = null;
    for (let i = 0; i < size; i++) value = { child: value };
    yield objectCase("depth:" + size, value);
  }
  for (const size of [9999, 10000, 10001]) {
    let remaining = size - 12;
    const groups = Array.from({ length: 10 }, () => {
      const count = Math.min(999, remaining);
      remaining -= count;
      return Array(count).fill(null);
    });
    assert.equal(remaining, 0);
    yield objectCase("nodes:" + size, { groups });
  }
  for (const size of [999999, 1000000, 1000001]) {
    const value = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => ["k" + i, "A".repeat(99990)]),
    );
    value.padding = "";
    const remaining = size - Buffer.byteLength(JSON.stringify(value));
    assert(remaining >= 0 && remaining <= 100000);
    value.padding = "A".repeat(remaining);
    assert.equal(Buffer.byteLength(JSON.stringify(value)), size);
    yield objectCase("bytes:" + size, value);
  }
  for (const value of [
    JSON.parse('{"__proto__":{"fixture":true},"constructor":1,"prototype":2}'),
    { invalidFirst: "A".repeat(100001), invalidLast: Array(1001).fill(null) },
    { invalidFirst: Array(1001).fill(null), invalidLast: "A".repeat(100001) },
  ])
    yield objectCase("ordering-and-own-keys", value);
  const finite = objectCase("nonfinite", { value: "nonfinite-placeholder" });
  yield {
    name: finite.name,
    raw: JSON.stringify(finite.input).replace(
      '"nonfinite-placeholder"',
      "1e999",
    ),
  };
}
