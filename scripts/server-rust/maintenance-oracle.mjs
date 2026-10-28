// Expectations execute the existing fingerprint and refresh-decision helpers.
import * as p from "../../packages/protocol/dist/index.js";
import { workerEncryptionRefreshChangesSurfaceMaterial } from "../../cantrip_server/src/worker-encryption-refresh.ts";
const components = p.workerEncryptionComponentScopeSchema.options;
const baseline = p.workerEncryptionStatusSchema.parse({
  supported: true,
  state: "ready",
  principalId: "33333333-3333-4333-8333-333333333333",
  grants: components.map((component, index) => ({
    component,
    keyRevision: index + 1,
  })),
  lastSyncedAt: "2026-10-25T00:00:00.000Z",
  error: null,
});
const variants = [
  baseline,
  { ...baseline, grants: [...baseline.grants].reverse() },
  { ...baseline, lastSyncedAt: null },
  { ...baseline, lastSyncedAt: "2026-10-26T00:00:00.000Z" },
  { ...baseline, principalId: "44444444-4444-4444-8444-444444444444" },
  { ...baseline, state: "error", error: "Unavailable 🔒" },
  { ...baseline, state: "pending-approval", principalId: null },
  p.unavailableWorkerEncryptionStatus,
  ...baseline.grants.map((_, index) => ({
    ...baseline,
    grants: baseline.grants.map((grant, i) => ({
      ...grant,
      keyRevision: grant.keyRevision + (i === index ? 1 : 0),
    })),
  })),
  ...components.map((_, index) => ({
    ...baseline,
    grants: baseline.grants.filter((_, i) => i !== index),
  })),
].map((status) => p.workerEncryptionStatusSchema.parse(status));
console.log(
  JSON.stringify(
    components.flatMap((component) =>
      variants.flatMap((before) =>
        variants.map((after) => ({
          component,
          before,
          after,
          fingerprint: p.workerEncryptionMaterialFingerprint(after),
          changed: workerEncryptionRefreshChangesSurfaceMaterial({
            component,
            before,
            after,
          }),
        })),
      ),
    ),
  ),
);
