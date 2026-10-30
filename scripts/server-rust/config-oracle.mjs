// Development-only oracle for porting configuration. Inputs contain synthetic
// fixture environments; inherited Cantrip/database settings are never included.
import { readServerConfig } from "../../cantrip_server/src/config.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";

function normalize(value) {
  if (value instanceof Uint8Array) return [...value];
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, normalize(entry)]),
    );
  return value;
}

export function observeConfiguration(cases) {
  const original = process.env;
  const base = Object.fromEntries(
    Object.entries(original).filter(
      ([name]) =>
        !name.startsWith("CANTRIP_") &&
        !["DATABASE_URL", "REDIS_URL"].includes(name),
    ),
  );
  const results = [];
  try {
    for (const scenario of cases) {
      process.env = { ...base, ...scenario.environment };
      try {
        results.push({
          ...scenario,
          accepted: true,
          configuration: normalize(readServerConfig()),
        });
      } catch (error) {
        results.push({
          ...scenario,
          accepted: false,
          error: { name: error.name, message: error.message },
        });
      }
    }
  } finally {
    process.env = original;
  }
  return { schemaVersion: 1, cwd: process.cwd(), results };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.stdin.setEncoding("utf8");
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  process.stdout.write(
    `${JSON.stringify(observeConfiguration(JSON.parse(input)), null, 2)}\n`,
  );
}
