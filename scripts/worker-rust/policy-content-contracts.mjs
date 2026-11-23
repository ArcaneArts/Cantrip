// Generate endpoint-only policy content and CLI output from the protocol package.
import { writeFile } from "node:fs/promises";
import { format } from "prettier";
import {
  policyCliListResultSchema,
  policyCliReadResultSchema,
  policyKeySchema,
  policyProtectedBodyContentSchema,
  policyProtectedSummaryContentSchema,
} from "../../packages/protocol/dist/policies.js";
import { buildContractManifest } from "../server-rust/contracts.mjs";

const schemas = {
  policyKeySchema,
  policyProtectedSummaryContentSchema,
  policyProtectedBodyContentSchema,
  policyCliListResultSchema,
  policyCliReadResultSchema,
};
const refinements = new Map([
  [policyCliListResultSchema.shape.policies, "stdio-mcp-policy-keys"],
]);
const manifest = buildContractManifest(Object.keys(schemas), {
  schemas,
  refinements,
});
await writeFile(
  new URL(
    "../../crates/cantrip-protocol/contracts/worker-policy-content.json",
    import.meta.url,
  ),
  await format(JSON.stringify(manifest), { parser: "json", tabWidth: 2 }),
);
