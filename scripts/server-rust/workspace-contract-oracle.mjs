import * as protocol from "../../packages/protocol/dist/index.js";
import { vectors } from "./security-oracle.mjs";
import { workspaceOwnershipVariants } from "./workspace-wire-fixtures.mjs";
const name = process.argv[2],
  result = vectors(name);
if (name === "workspaceOwnershipSchema")
  for (const input of workspaceOwnershipVariants().variants) {
    const value = protocol[name].safeParse(input);
    result.cases.push({
      input,
      outcome: value.success
        ? { ok: value.data }
        : { issues: value.error.issues },
      ...(!value.success ? { errorMessage: value.error.message } : {}),
    });
  }
console.log(JSON.stringify(result));
