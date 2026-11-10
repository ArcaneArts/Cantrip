import assert from "node:assert/strict";
import {
  settingsProject,
  settingsWorker as worker,
} from "./native-settings-http-fixture.mjs";
import {
  osHttpGuest,
  osHttpRuntime,
  osHttpProject as project,
} from "./cantrip-os-http-worker.mjs";

export async function cantripOsHttpRejections(
  h,
  control,
  result,
  { instance, binding, provision },
) {
  const endpoint = `/api/projects/${project}/cantrip-os/bindings/${binding.id}/run-definitions`;
  const input = {
    bindingGeneration: binding.bindingGeneration,
    attachmentGeneration: instance.attachmentGeneration,
    runtimeGeneration: osHttpRuntime,
    request: {
      type: "project.run-configuration-definitions.list",
      projectId: project,
      operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaa204",
    },
  };
  control.alias(h, input.request.operationId, "<OS rejection operation>");
  const count = (type) => result.commands.filter((c) => c.type === type).length;
  const before = count("cantrip-os.run-definition");
  await h.visit("Run request belongs to another project", "POST", endpoint, {
    json: {
      ...input,
      request: { ...input.request, projectId: settingsProject },
    },
    status: 409,
  });
  for (const key of ["bindingGeneration", "attachmentGeneration"])
    await h.visit("stale Run " + key, "POST", endpoint, {
      json: { ...input, [key]: "ffffffff-ffff-4fff-8fff-ffffffffffff" },
      status: 409,
    });
  assert.equal(
    count("cantrip-os.run-definition"),
    before,
    "invalid ownership/generation never reaches the worker",
  );
  for (const mode of ["wrong-operation-id", "wrong-operation", "failure"]) {
    control.setRunReply(mode);
    await h.visit("Run reply " + mode, "POST", endpoint, {
      json: input,
      status: 409,
    });
  }
  control.setRunReply("normal");
  const restored = await h.visit(
    "Run routing recovers after rejected replies",
    "POST",
    endpoint,
    { json: input },
  );
  assert.equal(restored.result.operation, "list");
  assert.equal(restored.result.operationId, input.request.operationId);
  const attach = {
    workerId: worker,
    guestInstanceId: osHttpGuest,
    name: "Controlled Linux",
    transport: { kind: "docker", container: "controlled-http-os" },
    expectedAttachmentGeneration: instance.attachmentGeneration,
  };
  const attachedCount = count("cantrip-os.attach");
  for (const mode of ["wrong-guest", "foreign-attachment"]) {
    control.setInspection(mode);
    await h.visit("attach rejects " + mode, "POST", "/api/cantrip-os/attach", {
      json: attach,
      status: 409,
    });
  }
  assert.equal(
    count("cantrip-os.attach"),
    attachedCount,
    "invalid observations cannot admit an attachment mutation",
  );
  await h.visit(
    "refresh rejects changed OS identity",
    "POST",
    `/api/cantrip-os/${instance.id}/refresh`,
    { status: 409 },
  );
  const uncertain = (
    await h.visit(
      "read uncertain OS after failed refresh",
      "GET",
      "/api/cantrip-os",
    )
  ).find((value) => value.id === instance.id);
  assert.equal(uncertain.status, "unknown");
  assert.equal(uncertain.runtimeGeneration, osHttpRuntime);
  assert.equal(uncertain.attachmentGeneration, instance.attachmentGeneration);
  control.setInspection("normal");
  const observed = await h.visit(
    "authoritative refresh recovers original attachment",
    "POST",
    `/api/cantrip-os/${instance.id}/refresh`,
  );
  assert.equal(observed.instance.status, "connected");
  assert.equal(
    observed.instance.attachmentGeneration,
    instance.attachmentGeneration,
  );
  result.proofs.push(
    "wrong project, stale selected generations, misrouted/failed worker replies and changed OS observations preserve authority; fresh observations restore availability without repeating mutations",
  );
  const bindings = `/api/projects/${project}/cantrip-os/bindings`;
  for (const relativePath of ["/outside/home", "nested/../outside"])
    await h.visit("existing source rejects " + relativePath, "POST", bindings, {
      json: {
        mode: "linux-existing",
        operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaa205",
        workspaceId: binding.workspaceId,
        sourceKind: "git",
        relativePath,
      },
      status: 409,
    });
  const sourcePath = bindings + "/" + binding.id;
  const mutations = count("cantrip-os.source.provision");
  for (const patch of [
    { bindingGeneration: "ffffffff-ffff-4fff-8fff-ffffffffffff" },
    { operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaa206" },
  ])
    await h.visit(
      "provision rejects changed " + Object.keys(patch)[0],
      "POST",
      sourcePath + "/provision",
      { json: { ...provision, ...patch }, status: 409 },
    );
  assert.equal(count("cantrip-os.source.provision"), mutations);
  control.setWrongReceiptBinding(true);
  await h.visit(
    "verification rejects another binding receipt",
    "POST",
    sourcePath + "/verify",
    { status: 409 },
  );
  control.setWrongReceiptBinding(false);
  assert.equal(
    (
      await h.visit(
        "verification recovers original binding",
        "POST",
        sourcePath + "/verify",
      )
    ).state,
    "ready",
  );
  control.setAttachFailure(true);
  await h.visit(
    "attachment loses completed worker acknowledgement",
    "POST",
    "/api/cantrip-os/attach",
    { json: attach, status: 409 },
  );
  control.setAttachFailure(false);
  const unobserved = (
    await h.visit(
      "read uncertain attachment generation",
      "GET",
      "/api/cantrip-os",
    )
  ).find((value) => value.id === instance.id);
  assert.equal(unobserved.status, "unknown");
  assert.equal(unobserved.runtimeGeneration, null);
  assert.notEqual(
    unobserved.attachmentGeneration,
    instance.attachmentGeneration,
  );
  control.alias(
    h,
    unobserved.attachmentGeneration,
    "<OS attachment after lost acknowledgement>",
  );
  await h.visit(
    "provision requires an observed executor generation",
    "POST",
    sourcePath + "/provision",
    { json: provision, status: 409 },
  );
  assert.equal(count("cantrip-os.source.provision"), mutations);
  const recovered = await h.visit(
    "refresh uncertain attachment without replaying attach",
    "POST",
    `/api/cantrip-os/${instance.id}/refresh`,
  );
  assert.equal(recovered.instance.status, "connected");
  assert.equal(
    recovered.instance.attachmentGeneration,
    unobserved.attachmentGeneration,
  );
  const verified = await h.visit(
    "verify source in recovered attachment",
    "POST",
    sourcePath + "/verify",
  );
  assert.equal(verified.state, "ready");
  assert.equal(
    verified.provisionedAttachmentGeneration,
    unobserved.attachmentGeneration,
  );
  result.proofs.push(
    "invalid existing paths, conflicting admission identities and foreign receipts roll back; an uncertain attach clears runtime authority and recovers through inspection and read-only source verification",
  );
  return recovered.instance;
}
