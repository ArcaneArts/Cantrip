import assert from "node:assert/strict";

// Preserve fixed fixture clocks exactly; validate actual generated wall clocks
// before comparing independent server runs. Raw rows are retained separately.
export function storedStateClocks(value, startedAt, key = "") {
  if (Array.isArray(value))
    return value.map((item) => storedStateClocks(item, startedAt, key));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([field, item]) => [
        field,
        storedStateClocks(item, startedAt, field),
      ]),
    );
  if (
    typeof value === "string" &&
    /(?:_at|At)$/.test(key) &&
    /^\d{4}-/.test(value)
  ) {
    const clock = Date.parse(value);
    assert.ok(Number.isFinite(clock), key);
    if (clock >= startedAt - 1000) {
      assert.ok(clock <= Date.now() + 1000, key);
      return "<validated stored wall clock>";
    }
  }
  return value;
}
