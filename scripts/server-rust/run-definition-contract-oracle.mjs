import { runDefinition } from "./run-lifecycle-http-cases.mjs";
import { runConfigurationGetResponseSchema } from "../../packages/protocol/dist/run-configuration-operations.js";
import { runConfigurationSecretSummaryListSchema } from "../../packages/protocol/dist/run-configuration-secrets.js";
import { outcome } from "./security-oracle.mjs";
const base = runDefinition({
  operationId: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  configurationId: "33333333-3333-4333-8333-333333333333",
});
const cases = [];
function add(schema, input) {
  cases.push({
    schema,
    input,
    outcome: outcome(
      schema === "runConfigurationGetResponseSchema"
        ? runConfigurationGetResponseSchema
        : runConfigurationSecretSummaryListSchema,
      input,
    ),
  });
}
add("runConfigurationGetResponseSchema", base);
for (const status of ["ready", "invalid", "unsupported"])
  for (const document of [null, base.result.entry.document])
    for (const revision of [null, "a".repeat(64)]) {
      const value = structuredClone(base);
      Object.assign(value.result.entry, { status, document, revision });
      add("runConfigurationGetResponseSchema", value);
    }
for (const configured of [false, true])
  for (const valid of [false, true])
    for (const revision of [null, "a".repeat(64)])
      for (const hasSetup of [false, true]) {
        const value = structuredClone(base);
        Object.assign(value.codexEnvironment, {
          configured,
          valid,
          revision,
          hasSetup,
        });
        add("runConfigurationGetResponseSchema", value);
      }
for (const available of [false, true])
  for (const revision of [null, 1])
    for (const updatedAt of [null, "2026-10-25T00:00:00.000Z"]) {
      const secret = {
        reference: "database/url",
        available,
        revision,
        updatedAt,
      };
      add("runConfigurationSecretSummaryListSchema", [secret]);
      add("runConfigurationSecretSummaryListSchema", [secret, secret]);
    }
const mismatched = structuredClone(base);
mismatched.result.entry.id = base.projectId;
add("runConfigurationGetResponseSchema", mismatched);
console.log(JSON.stringify({ cases }));
