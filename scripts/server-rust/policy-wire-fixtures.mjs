import { assets } from "./policy-assets.mjs";
const bytes = (n) => Buffer.alloc(n).toString("base64url");
export const policyEnvelope = {
  formatVersion: 1,
  keyRevision: 1,
  envelope: {
    version: 1,
    algorithm: "AES-256-GCM",
    keyRevision: 1,
    nonce: bytes(12),
    ciphertext: bytes(32),
  },
};
export const policyCreate = {
  id: "11111111-1111-4111-8111-111111111111",
  content: {
    keyBlindIndex: bytes(32),
    protectedSummary: policyEnvelope,
    protectedBody: policyEnvelope,
  },
  enabled: true,
  mandatory: false,
  audience: "ide",
  templateKey: null,
};
const summary = {
  ...policyCreate,
  content: { keyBlindIndex: bytes(32), protectedSummary: policyEnvelope },
  position: 0,
  rowVersion: 1,
  workspaceAssignmentCount: 0,
  projectAssignmentCount: 0,
  createdAt: "2026-10-25T00:00:00.000Z",
  updatedAt: "2026-10-25T00:00:00.000Z",
};
export const policyWireFixtures = {
  policyTemplateListSchema: [
    assets.templates.map(({ bodyMarkdown, ...summary }) => summary),
  ],
  policyTemplateDetailSchema: assets.templates.slice(0, 1),
  encryptedPolicyCreateSchema: [policyCreate],
  encryptedPolicyUpdateSchema: [
    { rowVersion: 1, enabled: false },
    {
      rowVersion: 2,
      content: {
        protectedSummary: policyEnvelope,
        protectedBody: policyEnvelope,
      },
      audience: "both",
      mandatory: true,
    },
  ],
  encryptedPolicyBootstrapSchema: [
    { expectedBootstrapVersion: 0, policies: [] },
    { expectedBootstrapVersion: 2, policies: [policyCreate] },
  ],
  policyWireDetailSchema: [{ ...summary, content: policyCreate.content }],
  policyWireListSchema: [
    { bootstrapVersion: 2, collectionVersion: 1, policies: [summary] },
  ],
  policyOrderUpdateSchema: [
    { collectionVersion: 1, policyIds: [policyCreate.id] },
  ],
  policyAssignmentUpdateSchema: [
    { collectionVersion: 1, policyIds: [policyCreate.id] },
  ],
  policyAssignmentWireListSchema: [
    {
      collectionVersion: 1,
      policies: [summary],
      directPolicyIds: [policyCreate.id],
    },
  ],
  policyDeleteSchema: [{ rowVersion: 1 }],
  effectivePolicyWireListSchema: [
    {
      policies: [
        {
          id: policyCreate.id,
          protectedSummary: policyEnvelope,
          mandatory: true,
          sources: [
            { type: "mandatory" },
            { type: "workspace", workspaceId: "workspace" },
            { type: "project", projectId: "project" },
          ],
        },
      ],
    },
  ],
  standalonePolicyWireListSchema: [
    {
      policies: [
        {
          id: policyCreate.id,
          protectedSummary: policyEnvelope,
          protectedBody: policyEnvelope,
        },
      ],
    },
  ],
};
