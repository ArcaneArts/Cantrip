import { sourceContractSchema } from "./contracts.mjs";
import { mcpSettingsBoundaryFixtures } from "./mcp-settings-wire-fixtures.mjs";

const cases = mcpSettingsBoundaryFixtures().map(({ schema, input }) => {
  const parsed = sourceContractSchema(schema).safeParse(input);
  return {
    schema,
    input,
    outcome: parsed.success
      ? { ok: parsed.data }
      : { issues: parsed.error.issues },
    ...(parsed.success ? {} : { errorMessage: parsed.error.message }),
  };
});
process.stdout.write(JSON.stringify({ cases }));
