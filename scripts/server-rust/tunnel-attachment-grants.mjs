import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { attachmentIds } from "./tunnel-state.mjs";
export async function attachmentGrants({ visit, result, id }) {
  const session = await visit(
    "attachment WorkerLink session",
    "POST",
    "/api/workers/alpha/worker-link/sessions",
    { json: { clientInstanceId: "attachment-grant-client" }, status: 201 },
  );
  const base = `/api/worker-links/${session.sessionId}`;
  const main = await visit(
    "attachment WorkerLink grant",
    "POST",
    `${base}/tunnel-attachments/${id}/grant`,
    { json: {}, status: 201 },
  );
  const sibling = await visit(
    "sibling attachment WorkerLink grant",
    "POST",
    `${base}/tunnel-attachments/${attachmentIds.sibling}/grant`,
    { json: {}, status: 201 },
  );
  for (const grant of [main.grant, sibling.grant]) {
    const install = result.commands.find(
      (command) =>
        command.type === "worker-link.grant.install" &&
        command.grant.binding.grantId === grant.binding.grantId,
    );
    assert.ok(install);
    assert.equal(install.grant.token, undefined);
    assert.equal(
      install.grant.tokenHash,
      createHash("sha256").update(grant.token).digest("hex"),
    );
  }
  return async () => {
    const revoked = result.commands.filter(
      (command) => command.type === "worker-link.grant.revoke",
    );
    assert.ok(
      revoked.some(
        (command) =>
          command.grantId === main.grant.binding.grantId &&
          command.revocation.reason === "resource-stopped",
      ),
    );
    assert.ok(
      !revoked.some(
        (command) => command.grantId === sibling.grant.binding.grantId,
      ),
      "credential rotation revokes only its owning attachment",
    );
    await visit(
      "rotated WorkerLink grant is missing",
      "POST",
      `${base}/grants/${main.grant.binding.grantId}/renew`,
      { status: 409 },
    );
    await visit(
      "sibling WorkerLink grant remains active",
      "POST",
      `${base}/grants/${sibling.grant.binding.grantId}/renew`,
    );
    await visit(
      "release sibling WorkerLink grant",
      "DELETE",
      `${base}/grants/${sibling.grant.binding.grantId}`,
      { status: 204 },
    );
    await visit("release attachment WorkerLink session", "DELETE", base, {
      status: 204,
    });
    result.attachmentGrantIsolation = {
      rotatedGrantRevoked: true,
      siblingGrantRenewed: true,
    };
  };
}
