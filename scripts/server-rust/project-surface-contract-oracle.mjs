import * as protocol from "../../packages/protocol/dist/index.js";
import { vectors, outcome } from "./security-oracle.mjs";
import { projectSurfaceWireFixtures } from "./project-surface-wire-fixtures.mjs";
import { projectLabel } from "./security-fixtures.mjs";
const name = process.argv[2],
  result = vectors(name),
  base = projectSurfaceWireFixtures(projectLabel)[name][0];
const extras = [];
if (name.includes("Create") || name.includes("Pin")) {
  for (const destination of [
    { paneId: "p", tabGroupId: "g" },
    { paneId: "p", targetRegion: "left" },
    { tabGroupId: "g", targetRegion: "right" },
    { paneId: "p", tabGroupId: "g", targetRegion: "center" },
  ])
    extras.push({ ...base, ...destination });
  extras.push({
    ...base,
    worktreeId: "tree",
    target: { kind: "project", projectId: "project" },
  });
}
if (base?.titleProtection)
  extras.push({
    ...base,
    titleProtection: {
      ...base.titleProtection,
      classification: { recordKind: "chat" },
    },
  });
for (const input of extras) {
  const schema = protocol[name],
    value = outcome(schema, input);
  result.cases.push({
    input,
    outcome: value,
    ...(value.issues
      ? { errorMessage: schema.safeParse(input).error.message }
      : {}),
  });
}
console.log(JSON.stringify(result));
