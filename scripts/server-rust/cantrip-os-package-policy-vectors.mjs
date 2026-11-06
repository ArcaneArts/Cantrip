import * as protocol from "../../packages/protocol/dist/index.js";
import { cantripOsPackageFixtures } from "./cantrip-os-package-fixtures.mjs";
const fixtures = cantripOsPackageFixtures();
const cases = [];
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
const artifact = fixtures.cantripOsPackageArtifactSchema[0];
add("cantripOsPackageArtifactsSchema", [artifact, artifact]);
for (const schema of [
  "cantripOsGuestPackageRequestSchema",
  "cantripOsPackageOperationCommandSchema",
  "cantripOsPackageCreateSchema",
])
  add(schema, {
    ...fixtures[schema][0],
    action: "upgrade",
    configuration: "package-defaults",
  });
add("cantripOsPackageOperationResultSchema", {
  ...fixtures.cantripOsPackageOperationResultSchema[0],
  protectedResult: null,
});
const limit = Math.ceil(
  ((protocol.CANTRIP_OS_PACKAGE_PRIVATE_BYTES + 16) * 4) / 3,
);
for (const bytes of [limit, limit + 1])
  add("cantripOsPackageProtectedResultSchema", {
    ...fixtures.cantripOsPackageProtectedResultSchema[0],
    ciphertext: "A".repeat(bytes),
  });
process.stdout.write(JSON.stringify(cases));
