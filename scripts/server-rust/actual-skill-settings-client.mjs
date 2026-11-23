// Existing browser SDK -> server -> full unchanged SkillManager/native worker.
// Only disposable skill files and the existing model HTTP server are fixtures.
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, stat, realpath } from "node:fs/promises";
import path from "node:path";

export async function actualSkillSettingsClient({
  page,
  fixture,
  projectId,
  chatId,
  projectRoot,
  workerDataDirectory,
  workerId,
  startWorker,
  stopWorker,
  model,
  result,
  requests,
}) {
  const description = "Private actual settings skill description 🌲",
    contents = "Private actual skill implementation 🌿",
    definitions = [
      {
        name: "cantrip-settings-project-proof",
        directory: path.join(
          projectRoot,
          ".agents",
          "skills",
          "cantrip-settings-project-proof",
        ),
        projectId,
      },
      {
        name: "cantrip-settings-account-proof",
        directory: path.join(
          workerDataDirectory,
          "codex-home",
          "skills",
          "cantrip-settings-account-proof",
        ),
        projectId: null,
      },
    ],
    baseline = model.requests.filter((r) => r.method === "POST").length;
  for (const entry of definitions) {
    entry.document = `---\nname: ${entry.name}\ndescription: ${description}\n---\n\n${contents}\n`;
    await mkdir(entry.directory, { recursive: true });
    await writeFile(path.join(entry.directory, "SKILL.md"), entry.document);
    await writeFile(path.join(entry.directory, "notes.md"), contents);
  }
  const providerId = await page.evaluate(
    async (chatId) =>
      (
        await (
          await import("/src/lib/api-client.ts")
        ).request(`/api/chats/${chatId}/customizations/target`)
      ).providerId,
    chatId,
  );
  const context = (projectId) => ({ workerId, providerId, projectId });
  const call = (operation, input) =>
    page.evaluate(
      async ({ operation, input }) =>
        (await import("/src/lib/api/customization.ts"))[operation](input),
      { operation, input },
    );
  const find = async (entry) => {
    const inventory = await call("getSettingsSkills", context(entry.projectId));
    const skill = [...inventory.project, ...inventory.global].find(
      (s) => s.name === entry.name,
    );
    assert.ok(skill, entry.name + " actually discovered by SkillManager");
    return skill;
  };
  for (const entry of definitions) {
    entry.skill = await find(entry);
    assert.equal(entry.skill.editable, true);
    assert.equal(entry.skill.deletable, true);
    assert.equal(entry.skill.location, entry.projectId ? "project" : "account");
    assert.equal(entry.skill.description, description);
    const input = { ...context(entry.projectId), skillId: entry.skill.id };
    const opened = await call("readSettingsSkill", input);
    assert.equal(opened.content, entry.document);
    assert.ok(opened.files.some((f) => f.path === "notes.md"));
    const updated = entry.document.replace(contents, contents + " updated");
    entry.document = updated;
    assert.deepEqual(
      await call("updateSettingsSkillFile", { ...input, content: updated }),
      { changed: true, recoveryPath: null },
    );
    assert.equal((await call("readSettingsSkill", input)).content, updated);
    assert.equal(
      await readFile(path.join(entry.directory, "SKILL.md"), "utf8"),
      updated,
    );
    assert.deepEqual(
      await call("updateSettingsSkillFile", {
        ...input,
        file: "notes.md",
        content: contents + " notes update",
      }),
      { changed: true, recoveryPath: null },
    );
    assert.equal(
      (await call("readSettingsSkill", { ...input, file: "notes.md" })).content,
      contents + " notes update",
    );
    if (!entry.projectId) {
      const canonicalPath = await realpath(entry.skill.path);
      assert.notEqual(
        entry.skill.path,
        canonicalPath,
        "owned worker alias provides the actual out-of-inventory account path",
      );
      const native = (operation, input) =>
        page.evaluate(
          async ({ chatId, operation, input }) =>
            (await import("/src/lib/api/customization.ts"))[operation](
              chatId,
              input,
            ),
          { chatId, operation, input },
        );
      const inventory = await native("getChatCustomizations", true);
      assert.equal(
        inventory.skills.items.find((s) => s.name === entry.name)?.path,
        canonicalPath,
      );
      for (const enabled of [false, true]) {
        assert.deepEqual(
          await native("configureChatSkill", { path: canonicalPath, enabled }),
          { path: canonicalPath, effectiveEnabled: enabled },
        );
        assert.equal((await find(entry)).enabled, enabled);
        assert.equal(
          (await native("getChatCustomizations", true)).skills.items.find(
            (s) => s.name === entry.name,
          )?.enabled,
          enabled,
        );
      }
    }
    for (const enabled of [false, true]) {
      if (entry.projectId) {
        assert.deepEqual(
          await call("configureSettingsSkill", { ...input, enabled }),
          { skillId: entry.skill.id, effectiveEnabled: enabled },
        );
        assert.equal((await find(entry)).enabled, enabled);
      } else {
        // SkillManager can edit account files independently of the active
        // managed native inventory. The owned alias makes the requested path
        // genuinely absent from that inventory on every OS. The guard rejects it;
        // preserve its authenticated failure rather than mutating another home.
        const failure = await page.evaluate(
          async (input) => {
            try {
              await (
                await import("/src/lib/api/customization.ts")
              ).configureSettingsSkill(input);
              return { succeeded: true };
            } catch (error) {
              return { name: error.name, message: error.message };
            }
          },
          { ...input, enabled },
        );
        assert.deepEqual(failure, {
          name: "CustomizationContentError",
          message:
            "The requested skill path is not present in this project's native Codex inventory.",
        });
        assert.equal((await find(entry)).enabled, true);
      }
    }
    const audience = entry.projectId ? "both" : "chat";
    assert.deepEqual(
      await call("updateSettingsSkillAudience", {
        workerId,
        providerId,
        audienceKey: entry.skill.audienceKey,
        audience,
      }),
      { audienceKey: entry.skill.audienceKey, audience },
    );
    assert.equal((await find(entry)).audience, audience);
  }
  const global = await call("getSettingsSkills", context(null));
  assert.deepEqual(global.project, []);
  assert.equal(
    global.global.some((s) => s.name === definitions[0].name),
    false,
  );
  const invalid = await page.evaluate(
    async (input) => {
      try {
        await (
          await import("/src/lib/api/customization.ts")
        ).updateSettingsSkillFile({
          ...input,
          content: "invalid skill front matter",
        });
        return { succeeded: true };
      } catch (error) {
        return { name: error.name, message: error.message };
      }
    },
    { ...context(projectId), skillId: definitions[0].skill.id },
  );
  assert.equal(invalid.name, "CustomizationContentError");
  assert.equal(
    await readFile(path.join(definitions[0].directory, "SKILL.md"), "utf8"),
    definitions[0].document,
  );
  const port = Number(new URL(fixture.server.origin).port);
  await stopWorker();
  await fixture.close();
  await fixture.start({ port });
  await startWorker();
  for (const entry of definitions) {
    const retained = await find(entry);
    assert.equal(retained.id, entry.skill.id);
    assert.equal(retained.audienceKey, entry.skill.audienceKey);
    assert.equal(retained.audience, entry.projectId ? "both" : "chat");
    assert.equal(
      (
        await call("readSettingsSkill", {
          ...context(entry.projectId),
          skillId: retained.id,
        })
      ).content,
      entry.document,
    );
    const deleted = await call("deleteSettingsSkill", {
      ...context(entry.projectId),
      skillId: retained.id,
    });
    assert.equal(deleted.changed, true);
    assert.ok(deleted.recoveryPath);
    await assert.rejects(
      stat(entry.directory),
      (error) => error.code === "ENOENT",
    );
    assert.equal(
      await readFile(path.join(deleted.recoveryPath, "SKILL.md"), "utf8"),
      entry.document,
    );
    const inventory = await call("getSettingsSkills", context(entry.projectId));
    assert.equal(
      [...inventory.project, ...inventory.global].some(
        (s) => s.id === retained.id,
      ),
      false,
    );
  }
  for (const marker of [
    description,
    contents,
    ...definitions.map((d) => d.name),
  ]) {
    assert.equal(
      JSON.stringify(requests).includes(marker),
      false,
      "private skill content/names do not reach server requests",
    );
    assert.equal(
      fixture.server.diagnostics().includes(marker),
      false,
      "private skill contents stay out of server diagnostics",
    );
  }
  assert.equal(
    model.requests.filter((r) => r.method === "POST").length,
    baseline,
    "settings file/audience/configuration operations never start inference",
  );
  result.skillSettingsSummary = {
    realSkillScopes: 2,
    encryptedReadWrite: true,
    nativeProjectConfigurationRoundTrip: true,
    accountConfigurationFailurePreserved: true,
    nativeAccountConfigurationRoundTrip: true,
    audienceRoundTrip: true,
    invalidWriteRetainsBytes: true,
    scopeIsolation: true,
    retainedAfterServerWorkerRestart: true,
    deletedWithRecoveryBytes: true,
    additionalModelRequests: 0,
  };
  result.steps.push(
    "existing browser Skill settings SDK reads and edits real project/account files, changes native configuration and audience, retains bytes across server/worker restart and deletes to verified recovery folders with endpoint opacity",
  );
}
