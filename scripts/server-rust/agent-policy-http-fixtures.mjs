import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import {
  encryptPolicyContent,
  decryptPolicySummaryContent,
  decryptPolicyBodyContent,
} from "../../packages/crypto/dist/policy-content.js";
import { literal, json } from "./project-target-state.mjs";
import { settingsProject as project } from "./native-settings-http-fixture.mjs";

export const policyIds = {
  mandatory: "eeeeeeee-eeee-4eee-8eee-000000000501",
  workspace: "eeeeeeee-eeee-4eee-8eee-000000000502",
  direct: "eeeeeeee-eeee-4eee-8eee-000000000503",
  disabled: "eeeeeeee-eeee-4eee-8eee-000000000504",
  chatOnly: "eeeeeeee-eeee-4eee-8eee-000000000505",
  unassigned: "eeeeeeee-eeee-4eee-8eee-000000000506",
  foreign: "eeeeeeee-eeee-4eee-8eee-000000000507",
};
export const privateMarker = "private-mcp-policy-content";
export async function seedPolicies(h) {
  const records = [];
  const workspace = "workspace:default:" + h.owner;
  await h.fixture.sql([
    `INSERT INTO users(id,kind,display_name) VALUES('mcp-foreign-policy-owner','anonymous','Other fixture owner')`,
    `INSERT INTO project_workspaces(id,owner_id) VALUES(${literal(workspace)},${literal(h.owner)}) ON CONFLICT DO NOTHING`,
    `INSERT INTO project_workspace_memberships(workspace_id,project_id) VALUES(${literal(workspace)},${literal(project)}) ON CONFLICT(project_id) DO UPDATE SET workspace_id=excluded.workspace_id`,
  ]);
  for (const [name, id] of Object.entries(policyIds)) {
    const ownerId = name === "foreign" ? "mcp-foreign-policy-owner" : h.owner;
    const context = {
      ownerId,
      policyId: id,
      keyRevision: 1,
      componentKey: new Uint8Array(32).fill(53),
    };
    const summary = {
      version: 1,
      key:
        name.replace(/[A-Z]/g, (letter) => "-" + letter.toLowerCase()) +
        "-policy",
      name: privateMarker + " " + name,
      summary: privateMarker + " summary 🔐",
    };
    const body = {
      version: 1,
      bodyMarkdown: "# " + privateMarker + "\n" + name,
    };
    const content = await encryptPolicyContent({ ...context, summary, body });
    records.push({ name, id, context, summary, body, content });
    await h.fixture.sql([
      `INSERT INTO policies(id,owner_id,key_blind_index,protected_summary,protected_body,enabled,mandatory,audience,position,created_at,updated_at) VALUES(${literal(id)},${literal(ownerId)},${literal(content.keyBlindIndex)},${json(content.protectedSummary)},${json(content.protectedBody)},${name !== "disabled"},${["mandatory", "foreign", "chatOnly"].includes(name)},${literal(name === "chatOnly" ? "chat" : name === "workspace" ? "both" : "ide")},${name === "mandatory" ? 2 : 1},'2026-10-25','2026-10-25')`,
    ]);
  }
  await h.fixture.sql([
    `INSERT INTO workspace_policy_assignments(policy_id,workspace_id) VALUES(${literal(policyIds.workspace)},${literal(workspace)})`,
    `INSERT INTO project_policy_assignments(policy_id,project_id) VALUES(${literal(policyIds.direct)},${literal(project)}),(${literal(policyIds.workspace)},${literal(project)}),(${literal(policyIds.disabled)},${literal(project)})`,
  ]);
  return {
    records,
    workspace,
    get: (id) => records.find((record) => record.id === id),
    async verifyRead(data, id) {
      const expected = this.get(id);
      assert.equal(data.policy.id, id);
      assert.deepEqual(data.policy.content, expected.content);
      assert.deepEqual(
        await decryptPolicySummaryContent({
          ...expected.context,
          encrypted: data.policy.content.protectedSummary,
        }),
        expected.summary,
      );
      assert.deepEqual(
        await decryptPolicyBodyContent({
          ...expected.context,
          encrypted: data.policy.content.protectedBody,
        }),
        expected.body,
      );
    },
    comparison(value) {
      if (Array.isArray(value))
        return value.map((item) => this.comparison(item));
      if (value && typeof value === "object") {
        if (value.envelope && value.formatVersion === 1) {
          for (const record of records)
            for (const field of ["protectedSummary", "protectedBody"]) {
              if (isDeepStrictEqual(value, record.content[field]))
                return `<verified ${record.id} ${field}>`;
            }
          assert.fail("Unknown or changed protected policy envelope");
        }
        return Object.fromEntries(
          Object.entries(value).map(([key, item]) => {
            if (key === "keyBlindIndex") {
              const record = records.find(
                (record) => record.content.keyBlindIndex === item,
              );
              assert.ok(
                record,
                "The actual returned blind index belongs to a seeded policy",
              );
              return [key, `<verified ${record.id} blind index>`];
            }
            return [key, this.comparison(item)];
          }),
        );
      }
      return value;
    },
  };
}
