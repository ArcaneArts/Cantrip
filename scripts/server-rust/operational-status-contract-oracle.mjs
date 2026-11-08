import { vectorCases } from "./security-oracle.mjs";
import fixtures from "./operational-status-wire-fixtures.json" with { type: "json" };
const schema = process.argv[2];
console.log(
  JSON.stringify({ cases: [...vectorCases(schema, fixtures[schema])] }),
);
