// Reuse the dedicated actual-Source oracle instead of duplicating its records.
import { cases } from "./native-suspension-oracle.mjs";

export function nativeSuspensionWireFixtures() {
  const fixtures = {};
  for (const { schema, input, outcome } of cases) {
    if (Object.hasOwn(outcome, "ok")) (fixtures[schema] ??= []).push(input);
  }
  return fixtures;
}
