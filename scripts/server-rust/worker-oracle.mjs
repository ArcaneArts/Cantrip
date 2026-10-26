// Development-only execution of actual worker contracts and Node boundaries.
import { workerHeartbeatSchema } from "../../packages/protocol/dist/index.js";
import { heartbeat } from "./security-fixtures.mjs";

if (process.argv.includes("--heartbeat-boundaries")) {
  const timestamps = [
    "2026-10-25T00:00:00Z",
    "2026-10-25T00:00Z",
    "2026-10-25T00:00:00.1Z",
    "2026-10-25T00:00:00.12Z",
    "2026-10-25T00:00:00.123Z",
    "2026-10-25T00:00:00.123456789123456789Z",
    "0000-02-29T00:00:00.9999Z",
    "2000-02-29T23:59:59.9999Z",
    "9999-12-31T23:59:59.9999Z",
    "1900-02-29T00:00Z",
    "2026-10-25T24:00Z",
    "2026-10-25T00:00:60Z",
    "2026-10-25T00:00:00+01:00",
    "2026-10-25T00:00:00",
    "2026-10-25 00:00:00Z",
  ];
  const cases = [];
  for (const startedAt of timestamps)
    for (const name of ["Fixture worker", " 🦀\ud800\udfff\udfff "]) {
      const input = { ...heartbeat, startedAt, name };
      const parsed = workerHeartbeatSchema.safeParse(input);
      if (!parsed.success) {
        cases.push({ input, valid: false });
        continue;
      }
      const value = parsed.data;
      for (const key of [
        "workerId",
        "name",
        "platform",
        "architecture",
        "codexVersion",
      ]) {
        if (typeof value[key] === "string")
          value[key] = Buffer.from(value[key], "utf8").toString("utf8");
      }
      value.startedAt = new Date(value.startedAt).toISOString();
      cases.push({ input, valid: true, stored: value });
    }
  process.stdout.write(JSON.stringify(cases));
} else throw new Error("Unknown worker oracle operation");
