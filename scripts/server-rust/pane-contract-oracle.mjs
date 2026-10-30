import * as protocol from "../../packages/protocol/dist/index.js";
import { vectors, outcome } from "./security-oracle.mjs";
import { paneWireFixtures } from "./pane-wire-fixtures.mjs";
import { projectLabel } from "./security-fixtures.mjs";
const name = process.argv[2],
  result = vectors(name),
  base = paneWireFixtures(projectLabel)[name][0];
const extras = [];
const orderField = {
  projectPaneOrderSchema: "paneIds",
  projectPaneMemberOrderSchema: "tabKeys",
  tabGroupMemberOrderSchema: "tabKeys",
  tabGroupOrderSchema: "groupIds",
}[name];
if (orderField)
  for (const ids of [
    ["a", "a"],
    ["\ud800", "\ud800"],
    ["\ud800", "�"],
  ])
    extras.push({ ...base, [orderField]: ids });
if (name === "projectPaneMemberMoveSchema")
  for (const targetPaneId of [null, "pane"])
    for (const targetRegion of [undefined, "center", "right", "bottom", "left"])
      for (const targetPanePosition of [undefined, 0, 1])
        extras.push({
          ...base,
          targetPaneId,
          targetRegion,
          targetPanePosition,
        });
if (name === "tabGroupMemberMoveSchema")
  extras.push({ ...base, targetGroupId: null, targetGroupPosition: undefined });
if (name === "projectSurfaceViewOpenSchema")
  extras.push({ ...base, targetPaneId: "pane", targetRegion: "center" });
if (
  [
    "encryptedProjectPaneUpdateSchema",
    "encryptedTabGroupUpdateSchema",
  ].includes(name)
)
  extras.push({
    ...base,
    titleProtection: {
      ...base.titleProtection,
      classification: { recordKind: "chat" },
    },
  });
for (const input of extras) {
  const schema = protocol[name],
    canonical = JSON.parse(JSON.stringify(input)),
    value = outcome(schema, canonical);
  result.cases.push({
    input: canonical,
    outcome: value,
    ...(value.issues
      ? { errorMessage: schema.safeParse(canonical).error.message }
      : {}),
  });
}
console.log(JSON.stringify(result));
