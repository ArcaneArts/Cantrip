// Actual Node utility semantics used by the production fork reread guard.
import { isDeepStrictEqual } from "node:util";

const values = [
  null,
  "1970-01-01T00:00:00.000Z",
  "1969-12-31T23:59:59.999Z",
  "2026-10-25T00:00:00.123Z",
  "2026-10-25T00:00:00.123999Z",
  "2026-10-25T01:00:00.123+01:00",
  "+010000-01-01T00:00:00.000Z",
  "+275760-09-13T00:00:00.000Z",
  "+275760-09-13T00:00:00.001Z",
  "infinity",
  "-infinity",
];
const revive = (row) =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      key.endsWith("_at") && value !== null ? new Date(value) : value,
    ]),
  );
const cases = [];
const add = (left, right) =>
  cases.push({
    left,
    right,
    equal: isDeepStrictEqual(revive(left), revive(right)),
  });
for (const field of ["created_at", "updated_at", "removed_at"])
  for (const left of values)
    for (const right of values)
      add(
        { [field]: left, metadata: { sequence: 1, array: ["a", "b"] } },
        { metadata: { array: ["a", "b"], sequence: 1 }, [field]: right },
      );
for (const time of values) {
  const row = { updated_at: time, metadata: { timestamp: "infinity" } };
  add(row, { ...row, metadata: { timestamp: null } });
  add(row, { ...row, extra: null });
  add(row, { ...row, metadata: { timestamp: "-infinity" } });
  add(
    { updated_at: time, metadata: { updated_at: "infinity" } },
    { updated_at: time, metadata: { updated_at: "-infinity" } },
  );
}
console.log(JSON.stringify({ nodeVersion: process.version, cases }));
