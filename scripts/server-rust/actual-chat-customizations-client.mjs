// Browser customization/native permission SDK -> server -> unchanged full
// worker -> actual Codex. Only disposable skill files and model HTTP are fixtures.
import assert from "node:assert/strict";
import { mkdir, writeFile, realpath } from "node:fs/promises";
import path from "node:path";
import { eventually } from "./full-worker.mjs";

export async function actualChatCustomizationsClient({
  page,
  fixture,
  chatId,
  projectRoot,
  startWorker,
  stopWorker,
  model,
  result,
  requests,
}) {
  const name = "cantrip-private-customization-proof",
    extraName = "cantrip-private-extra-skill-proof",
    description = "Private actual customization description 🌲",
    server = "private-cantrip-mcp-proof",
    importId = "private-cantrip-import-proof",
    skill = path.join(projectRoot, ".agents", "skills", name, "SKILL.md"),
    extraRoot = path.join(projectRoot, "private-extra-skill-roots"),
    extraSkill = path.join(extraRoot, extraName, "SKILL.md"),
    baseline = model.requests.filter((r) => r.method === "POST").length;
  for (const [file, skillName] of [
    [skill, name],
    [extraSkill, extraName],
  ]) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      `---\nname: ${skillName}\ndescription: ${description}\n---\n\nDisposable native discovery proof.\n`,
    );
  }
  const canonicalSkill = await realpath(skill),
    canonicalExtra = await realpath(extraRoot);
  const api = (operation, input) =>
    page.evaluate(
      async ({ chatId, operation, input }) => {
        const api = await import("/src/lib/api/customization.ts");
        return api[operation](chatId, input);
      },
      { chatId, operation, input },
    );
  const inventory = () => api("getChatCustomizations", true);
  const discovered = await inventory();
  assert.equal(
    discovered.skills.items.find((s) => s.name === name)?.path,
    canonicalSkill,
  );
  assert.equal(
    discovered.skills.items.find((s) => s.name === name)?.description,
    description,
  );
  assert.ok(
    (await api("getSkills")).some(
      (s) => s.name === name && s.description === description,
    ),
  );
  for (const enabled of [false, true]) {
    assert.deepEqual(
      await api("configureChatSkill", { path: canonicalSkill, enabled }),
      {
        path: canonicalSkill,
        effectiveEnabled: enabled,
      },
    );
    assert.equal(
      (await inventory()).skills.items.find((s) => s.name === name)?.enabled,
      enabled,
    );
  }
  assert.deepEqual(
    await api("setChatSkillRoots", { roots: ["private-extra-skill-roots"] }),
    { roots: [canonicalExtra] },
  );
  const extra = await inventory();
  assert.deepEqual(extra.skillRoots, [canonicalExtra]);
  assert.ok(extra.skills.items.some((s) => s.name === extraName));
  assert.deepEqual(await api("reloadChatMcpServers"), { reloaded: true });
  assert.deepEqual(await api("getChatMcpOauthStatus", server), {
    server,
    status: "unknown",
    error: null,
  });
  assert.deepEqual(await api("getChatExternalImportStatus", importId), {
    importId,
    status: "unknown",
    results: [],
  });
  assert.equal(
    (await api("getChatExternalImportPreview")).sourceScope,
    "project",
  );
  const failures = [];
  for (const [operation, input] of [
    [
      "readChatMcpResource",
      { server, uri: "private://cantrip-resource-proof" },
    ],
    ["startChatMcpOauth", { server }],
    ["applyChatExternalImport", { itemIds: [importId] }],
  ]) {
    const failed = await page.evaluate(
      async ({ chatId, operation, input }) => {
        try {
          await (
            await import("/src/lib/api/customization.ts")
          )[operation](chatId, input);
          return { succeeded: true };
        } catch (error) {
          return { name: error.name, message: error.message };
        }
      },
      { chatId, operation, input },
    );
    assert.equal(
      failed.name,
      "CustomizationContentError",
      operation + " returns an authenticated, decrypted native failure",
    );
    assert.ok(failed.message.length);
    failures.push({ operation, error: failed.name });
  }
  assert.deepEqual(await api("getChatMcpOauthStatus", server), {
    server,
    status: "failed",
    error: "Codex could not start MCP authorization.",
  });
  const permissionView = () =>
    page.evaluate(
      async (chatId) =>
        (await import("/src/lib/api/chats.ts")).getChatPermissionProfiles(
          chatId,
        ),
      chatId,
    );
  const original = await permissionView(),
    transitions = [];
  for (const selectedId of [
    ":read-only",
    original.usesDefault ? null : original.selectedId,
  ]) {
    const sent = await page.evaluate(
      async ({ chatId, selectedId }) => {
        const identity = (
            await import("/src/lib/client-session.ts")
          ).getClientSessionIdentitySnapshot(),
          state = await (
            await import("/src/lib/native-settings-api.ts")
          ).readNativeSettingsState({ chatId, identity, refresh: true }),
          menu = await (
            await import("/src/lib/api/chats.ts")
          ).getChatPermissionProfiles(chatId),
          operationId = crypto.randomUUID(),
          receipt = await (
            await import("/src/lib/native-permission-update.ts")
          ).sendNativePermissionUpdate({
            chatId,
            identity,
            request: {
              id: selectedId,
              operationId,
              bindingId: state.binding.bindingId,
              expectedRevision: menu.policyRevision,
            },
          });
        return { operationId, receipt };
      },
      { chatId, selectedId },
    );
    assert.ok(
      ["applied", "queued", "requesting"].includes(sent.receipt.status),
    );
    const settled = await eventually(
      async () => {
        return page.evaluate(async (chatId) => {
          const identity = (
            await import("/src/lib/client-session.ts")
          ).getClientSessionIdentitySnapshot();
          return {
            native: await (
              await import("/src/lib/native-settings-api.ts")
            ).readNativeSettingsState({ chatId, identity }),
            menu: await (
              await import("/src/lib/api/chats.ts")
            ).getChatPermissionProfiles(chatId),
          };
        }, chatId);
      },
      ({ native, menu }) => {
        assert.equal(native.permissionPolicy?.operationId, sent.operationId);
        assert.equal(native.permissionPolicy.selectedId, selectedId);
        assert.equal(menu.selectedId, selectedId ?? original.selectedId);
        assert.equal(menu.effectiveId, selectedId ?? original.effectiveId);
        assert.equal(menu.confirmed, true);
      },
      60000,
    );
    transitions.push({
      selectedId,
      effectiveId: settled.menu.effectiveId,
      confirmed: settled.menu.confirmed,
    });
  }
  assert.deepEqual(await api("setChatSkillRoots", { roots: [] }), {
    roots: [],
  });
  // Native skill configuration is durable, whereas extra roots belong to the
  // runtime. Exercise the real shutdown/reconnect with the skill disabled.
  await api("configureChatSkill", { path: canonicalSkill, enabled: false });
  const port = Number(new URL(fixture.server.origin).port);
  await stopWorker();
  await fixture.close();
  await fixture.start({ port });
  await startWorker();
  const coldInventory = await page.evaluate(async (chatId) => {
    try {
      await (
        await import("/src/lib/api/customization.ts")
      ).getChatCustomizations(chatId, true);
      return { succeeded: true };
    } catch (error) {
      return { name: error.name, message: error.message };
    }
  }, chatId);
  assert.equal(coldInventory.name, "CustomizationContentError");
  assert.match(coldInventory.message, /^thread not found: /u);
  // Inventory includes thread-scoped MCP status. Source does not resume a cold
  // native thread for that read. Use the existing explicit native Goal control
  // to resume with its preserved configuration, without starting inference.
  assert.equal(
    (
      await page.evaluate(
        async (chatId) =>
          (await import("/src/lib/api/chats.ts")).clearChatGoal(chatId),
        chatId,
      )
    ).cleared,
    false,
  );
  assert.equal(
    (await inventory()).skills.items.find((s) => s.name === name)?.enabled,
    false,
  );
  const retainedPermissions = await permissionView();
  assert.equal(retainedPermissions.selectedId, original.selectedId);
  assert.equal(retainedPermissions.effectiveId, original.effectiveId);
  assert.equal(retainedPermissions.usesDefault, original.usesDefault);
  assert.deepEqual(
    await api("configureChatSkill", { path: canonicalSkill, enabled: true }),
    { path: canonicalSkill, effectiveEnabled: true },
  );
  assert.equal(
    model.requests.filter((r) => r.method === "POST").length,
    baseline,
    "customizations and permission updates do not start inference",
  );
  for (const marker of [
    name,
    extraName,
    description,
    server,
    importId,
    canonicalSkill,
    canonicalExtra,
  ]) {
    assert.equal(
      JSON.stringify(requests).includes(marker),
      false,
      "customization content stays opaque in browser-to-server requests",
    );
    assert.equal(
      fixture.server.diagnostics().includes(marker),
      false,
      "customization content stays out of server diagnostics",
    );
  }
  result.chatCustomizationSummary = {
    realSkillsDiscovered: 2,
    skillConfigurationRoundTrip: true,
    extraRootsRoundTrip: true,
    mcpReloaded: true,
    encryptedNativeFailures: failures,
    boundPermissionTransitions: transitions,
    retainedAfterServerAndWorkerRestart: true,
    coldInventoryErrorPreserved: true,
    additionalModelRequests: 0,
  };
  result.steps.push(
    "existing browser SDK discovers real skills, changes native configuration and roots, decrypts MCP/import failures, confirms bound permissions and retains state across server/worker restart without inference",
  );
}
