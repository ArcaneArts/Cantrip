import * as protocol from "../../packages/protocol/dist/index.js";
import { cantripOsSystemFixtures } from "./cantrip-os-system-fixtures.mjs";
const fixtures = cantripOsSystemFixtures(),
  cases = [];
function add(schema, input) {
  const parsed = protocol[schema].safeParse(input);
  cases.push({
    schema,
    input,
    outcome: parsed.success
      ? { ok: parsed.data }
      : { issues: parsed.error.issues },
  });
}
add("cantripOsSystemOperationResultSchema", {
  ...fixtures.cantripOsSystemOperationResultSchema[0],
  protectedResult: null,
});
const limit = Math.ceil(
  ((protocol.CANTRIP_OS_SYSTEM_RESULT_BYTES + 16) * 4) / 3,
);
for (const command of fixtures.cantripOsSystemWorkerCommandSchema)
  add("workerRequestEnvelopeSchema", {
    kind: "request",
    requestId: "fixture-system-command",
    command,
  });
for (const bytes of [limit, limit + 1])
  add("cantripOsSystemProtectedOperationResultSchema", {
    ...fixtures.cantripOsSystemProtectedOperationResultSchema[0],
    ciphertext: "A".repeat(bytes),
  });
process.stdout.write(JSON.stringify(cases));
