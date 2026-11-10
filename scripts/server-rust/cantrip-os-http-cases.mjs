import assert from "node:assert/strict";
import { cantripOsHttpRejections } from "./cantrip-os-http-rejections.mjs";
import {
  cantripOsSourceBindingSummarySchema,
  cantripOsRunDefinitionResponseSchema,
  cantripOsBackupSummarySchema,
} from "../../packages/protocol/dist/index.js";
import { settingsWorker as worker } from "./native-settings-http-fixture.mjs";
import {
  osHttpProject as project,
  osHttpGuest,
  osHttpRuntime,
  osHttpPrivate,
} from "./cantrip-os-http-worker.mjs";

export async function cantripOsHttpCases(h, control, result, profile) {
  const visit = h.visit;
  for (const [id, name] of [
    [project, "<OS project>"],
    [osHttpGuest, "<OS guest>"],
    [osHttpRuntime, "<OS runtime>"],
  ])
    control.alias(h, id, name);
  await visit(
    "attach rejects malformed input",
    "POST",
    "/api/cantrip-os/attach",
    { json: {}, status: 400 },
  );
  const attached = await visit(
    "attach owned OS",
    "POST",
    "/api/cantrip-os/attach",
    {
      json: {
        workerId: worker,
        guestInstanceId: osHttpGuest,
        name: "Controlled Linux",
        transport: { kind: "docker", container: "controlled-http-os" },
        expectedAttachmentGeneration: null,
      },
    },
  );
  assert.equal(attached.instance.guestInstanceId, osHttpGuest);
  assert.equal(attached.instance.runtimeGeneration, osHttpRuntime);
  assert.equal(attached.instance.workerId, worker);
  assert.equal(attached.workspaces.length, 1);
  let instance = attached.instance;
  const workspace = attached.workspaces[0];
  for (const [id, name] of [
    [instance.id, "<OS instance>"],
    [instance.attachmentGeneration, "<OS initial attachment>"],
    [workspace.id, "<OS workspace>"],
  ])
    control.alias(h, id, name);
  control.setAttachReply("observation");
  const reattached = await visit(
    "reattach accepts observed acknowledgement",
    "POST",
    "/api/cantrip-os/attach",
    {
      json: {
        workerId: worker,
        guestInstanceId: osHttpGuest,
        name: "Controlled Linux",
        transport: { kind: "docker", container: "controlled-http-os" },
        expectedAttachmentGeneration: instance.attachmentGeneration,
      },
    },
  );
  assert.equal(reattached.instance.id, instance.id);
  assert.notEqual(
    reattached.instance.attachmentGeneration,
    instance.attachmentGeneration,
  );
  assert.equal(reattached.workspaces[0].id, workspace.id);
  instance = reattached.instance;
  control.alias(h, instance.attachmentGeneration, "<OS attachment>");
  result.proofs.push(
    "void and observed acknowledgements both reach an authoritative fresh inspection; reattachment rotates its generation and retains workspace identity",
  );
  async function restart(label) {
    const server = h.fixture.server;
    const port = Number(new URL(server.origin).port);
    await h.live.close();
    h.worker.close();
    await h.fixture.close();
    result.serverExits.push({ label, diagnostics: server.diagnostics() });
    await h.fixture.start({ port });
    await h.reconnectWorker();
    assert.equal(
      (await visit(label + " identity after restart", "GET", "/api/bootstrap"))
        .server.id,
      h.serverId,
    );
  }
  const refresh = await visit(
    "refresh canonical OS workspaces",
    "POST",
    `/api/cantrip-os/${instance.id}/refresh`,
  );
  assert.equal(refresh.instance.id, instance.id);
  assert.deepEqual(refresh.workspaces, attached.workspaces);
  const bindings = `/api/projects/${project}/cantrip-os/bindings`;
  await visit("binding schema rejects forged guest receipt", "POST", bindings, {
    json: {
      mode: "linux-owned",
      workspaceId: workspace.id,
      sourceKind: "git",
      uid: 0,
    },
    status: 400,
  });
  if (profile === "accounts") {
    await visit(
      "foreign owner cannot refresh OS",
      "POST",
      `/api/cantrip-os/${instance.id}/refresh`,
      { client: "other", status: 409 },
    );
    await visit(
      "foreign owner cannot create source binding",
      "POST",
      bindings,
      {
        client: "other",
        json: {
          mode: "linux-owned",
          workspaceId: workspace.id,
          sourceKind: "git",
        },
        status: 409,
      },
    );
  }
  const binding = await visit("create Linux source binding", "POST", bindings, {
    json: { mode: "linux-owned", workspaceId: workspace.id, sourceKind: "git" },
  });
  cantripOsSourceBindingSummarySchema.parse(binding);
  assert.equal(binding.state, "provisioning");
  assert.equal(binding.projectId, project);
  assert.equal(binding.instanceId, instance.id);
  assert.equal(binding.workspaceId, workspace.id);
  for (const [id, name] of [
    [binding.id, "<OS binding>"],
    [binding.bindingGeneration, "<OS binding generation>"],
    [binding.projectSourceId, "<OS source>"],
    [binding.worktreeId, "<OS worktree>"],
  ])
    control.alias(h, id, name);
  const path = bindings + "/" + binding.id;
  const operationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaa201";
  control.alias(h, operationId, "<OS provision operation>");
  const provision = {
    operationId,
    bindingGeneration: binding.bindingGeneration,
    protectedRequest: await control.provisionRequest(h, binding, operationId),
  };
  const count = (type) => result.commands.filter((c) => c.type === type).length;
  await visit(
    "provisioning loses completed worker acknowledgement",
    "POST",
    path + "/provision",
    { json: provision, status: 409 },
  );
  assert.equal(count("cantrip-os.source.provision"), 1);
  await restart("provision acknowledgement lost");
  const recovered = await visit(
    "recover original provisioning admission",
    "POST",
    path + "/recover",
  );
  assert.equal(recovered.state, "ready");
  assert.equal(recovered.operationId, operationId);
  assert.equal(recovered.receipt.source.bindingId, binding.id);
  const replay = await visit(
    "provision replay observes original mutation",
    "POST",
    path + "/provision",
    { json: provision },
  );
  assert.deepEqual(replay, recovered);
  assert.equal(count("cantrip-os.source.provision"), 1);
  result.proofs.push(
    "server and worker reconnect after lost provisioning acknowledgement; canonical admission recovers and replay never repeats the mutation",
  );
  const verified = await visit(
    "read-only verification records current generation",
    "POST",
    path + "/verify",
  );
  cantripOsSourceBindingSummarySchema.parse(verified);
  assert.equal(verified.state, "ready");
  assert.equal(
    verified.provisionedAttachmentGeneration,
    instance.attachmentGeneration,
  );
  assert.equal(verified.provisionedRuntimeGeneration, osHttpRuntime);
  control.alias(
    h,
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaa202",
    "<OS definition operation>",
  );
  const definitions = await visit(
    "list definitions in canonical Linux source",
    "POST",
    path + "/run-definitions",
    {
      json: {
        bindingGeneration: binding.bindingGeneration,
        attachmentGeneration: instance.attachmentGeneration,
        runtimeGeneration: osHttpRuntime,
        request: {
          type: "project.run-configuration-definitions.list",
          operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaa202",
          projectId: project,
        },
      },
    },
  );
  cantripOsRunDefinitionResponseSchema.parse(definitions);
  assert.equal(definitions.source.bindingId, binding.id);
  assert.equal(definitions.source.worktreeId, binding.worktreeId);
  assert.deepEqual(definitions.result.inventory.entries, []);
  instance = await cantripOsHttpRejections(h, control, result, {
    instance,
    binding,
    provision,
  });
  const backupId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaa203";
  control.alias(h, backupId, "<OS backup operation>");
  const backupRequest = {
    action: "capture",
    operationId: backupId,
    workspaceId: workspace.id,
    attachmentGeneration: instance.attachmentGeneration,
    runtimeGeneration: osHttpRuntime,
    protectedRequest: await control.backupRequest(h, backupId, {
      action: "capture",
      workspaceId: workspace.id,
      label: osHttpPrivate,
      exclusions: [],
    }),
  };
  const unknown = await visit(
    "backup loses completed worker acknowledgement",
    "POST",
    `/api/cantrip-os/${instance.id}/backup-operations`,
    { json: backupRequest },
  );
  cantripOsBackupSummarySchema.parse(unknown);
  assert.equal(unknown.result.state, "unknown");
  assert.equal(count("cantrip-os.backup.capture"), 1);
  await restart("backup acknowledgement lost");
  const backup = await visit(
    "recover original backup without repeating capture",
    "POST",
    `/api/cantrip-os/backup-operations/${backupId}/recovery`,
    { json: { mode: "observe" } },
  );
  cantripOsBackupSummarySchema.parse(backup);
  assert.equal(backup.result.state, "ready");
  await control.proveBackup(h, backup);
  const replayedBackup = await visit(
    "backup replay observes retained capture",
    "POST",
    `/api/cantrip-os/${instance.id}/backup-operations`,
    { json: backupRequest },
  );
  assert.equal(replayedBackup.result.state, "ready");
  assert.deepEqual(
    replayedBackup.protectedRequest,
    backupRequest.protectedRequest,
  );
  assert.deepEqual(replayedBackup.result, backup.result);
  assert.equal(count("cantrip-os.backup.capture"), 1);
  result.proofs.push(
    "server and worker reconnect after lost backup acknowledgement; recovery and replay observe the original capture",
  );
  const publicContent = JSON.stringify([
    ...h.fixture.records.values(),
    h.live.history,
  ]);
  const diagnostics = [
    h.diagnostics(),
    ...result.serverExits.map((exit) => exit.diagnostics),
  ].join("\n");
  for (const privateText of [
    osHttpPrivate,
    encodeURIComponent(osHttpPrivate),
  ]) {
    assert.equal(publicContent.includes(privateText), false);
    assert.equal(diagnostics.includes(privateText), false);
  }
  result.observations = control.canonical(result.observations);
  result.commands = control.canonical(h.fixture.normalize(result.commands));
  return { instance, workspace, binding, provision, backupRequest };
}
