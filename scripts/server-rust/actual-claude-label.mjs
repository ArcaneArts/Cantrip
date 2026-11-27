import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { eventually } from "./full-worker.mjs";
import { taskModelProvider } from "./task-model-provider.mjs";

const fixture = `#!/bin/sh
case "$1" in
  --version) echo '2.1.1 (Claude Code)'; exit 0 ;;
  --print) ;;
  *) exit 2 ;;
esac
printf '%s\\n' "$@" > "$HOME/fixture-arguments"
cat > "$HOME/fixture-input"
if grep -q 'orchard' "$HOME/fixture-input"; then title='Inventory orchard crates'; else title='Review garden notes'; fi
printf '{"type":"result","subtype":"success","is_error":false,"result":"%s"}\\n' "$title"
`;

export async function installClaudeCodeFixture(
  workerDirectory,
  program = fixture,
) {
  const root = path.join(workerDirectory, "managed-runtimes", "claude-code");
  const checksum = createHash("sha256").update(program).digest("hex");
  const directory = path.join(root, "versions", checksum);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(directory, "claude"), program, { mode: 0o700 });
  await writeFile(
    path.join(root, "current.json"),
    JSON.stringify({
      schemaVersion: 1,
      active: { version: "2.1.1", checksum, size: Buffer.byteLength(program) },
      previous: null,
    }),
    { mode: 0o600 },
  );
  return path.join(root, "profiles");
}

export async function actualClaudeLabel({
  page,
  workerId,
  projectId,
  workerDirectory,
  result,
  diagnostics,
}) {
  const profiles = await installClaudeCodeFixture(workerDirectory);
  const taskModel = await taskModelProvider();
  try {
    const { providerId, ids } = await page.evaluate(
      async ({ workerId, baseUrl, model, projectId }) => {
        const models = await import("/src/lib/api/models.ts");
        const settings = await import("/src/lib/api/settings.ts");
        const tasks = await import("/src/lib/api/tasks.ts");
        const provider = await models.createModelProvider({
          name: "Claude Code",
          kind: "claude-code",
          baseUrl: "https://claude-code.invalid",
        });
        const ids = [];
        for (const label of ["Orchard", "Garden"]) {
          const account = await models.createModelProviderAccount(provider.id, {
            label,
            boundWorkerId: workerId,
          });
          ids.push(account.id);
        }
        const naming = await models.createModelProfile({
          name: "Claude label fixture",
          routes: [
            { providerId: provider.id, modelName: "sonnet", enabled: true },
          ],
        });
        const execution = await models.createModelProvider({
          name: "Disposable ordinary Task model",
          kind: "openai-compatible",
          baseUrl,
        });
        const fallback = await models.createModelProfile({
          name: "Ordinary Task execution",
          routes: [
            { providerId: execution.id, modelName: model, enabled: true },
          ],
        });
        await settings.updateSettings({
          labelingModelId: naming.id,
          defaultModelId: fallback.id,
          autoNameTasks: true,
        });
        const { getWorkers } = await import("/src/lib/api/worker-wire.ts");
        const worker = (await getWorkers()).find(
          (worker) => worker.workerId === workerId,
        );
        const { ensureTaskWorkerEncryption } =
          await import("/src/lib/task-worker-encryption.ts");
        await ensureTaskWorkerEncryption({ worker });
        const pause = await tasks.getProjectTaskPauseState(projectId);
        await tasks.setProjectTaskPauseState(projectId, {
          paused: true,
          rowVersion: pause.rowVersion,
        });
        return { providerId: provider.id, ids };
      },
      {
        workerId,
        baseUrl: taskModel.baseUrl,
        model: taskModel.model,
        projectId,
      },
    );
    const evidence = [];
    for (const { brief, title, order } of [
      {
        brief: "Count orchard crates",
        title: "Inventory orchard crates",
        order: ids,
      },
      {
        brief: "Review the garden notes",
        title: "Review garden notes",
        order: ids.toReversed(),
      },
    ]) {
      const chatId = await page.evaluate(
        async ({ projectId, workerId, providerId, brief, order }) => {
          const tasks = await import("/src/lib/api/tasks.ts");
          const { reorderModelProviderAccounts } =
            await import("/src/lib/api/models.ts");
          const { getWorkers } = await import("/src/lib/api/worker-wire.ts");
          await reorderModelProviderAccounts(providerId, order);
          const { chat, task } = await tasks.createTask(projectId, undefined);
          const draft = await tasks.updateTaskDraft(chat.id, {
            rowVersion: task.rowVersion,
            briefMarkdown: brief,
          });
          const worker = (await getWorkers()).find(
            (candidate) => candidate.workerId === workerId,
          );
          await tasks.startTaskDirectly(
            chat.id,
            { operationId: crypto.randomUUID(), rowVersion: draft.rowVersion },
            worker,
          );
          return chat.id;
        },
        { projectId, workerId, providerId, brief, order },
      );
      const saved = await eventually(
        () =>
          page.evaluate(
            async ({ projectId, chatId }) => {
              const { chatTitleEncryption } =
                await import("/src/lib/chat-title-encryption.ts");
              const rows = await window.folderRequest(
                `/api/projects/${projectId}/chats`,
              );
              const wire = rows.find((row) => row.id === chatId);
              return {
                wire,
                title: (await chatTitleEncryption.open(wire)).title,
              };
            },
            { projectId, chatId },
          ),
        (current) => assert.equal(current.title, title, diagnostics()),
      );
      assert.ok(saved.wire.titleProtection.protectedLabel.envelope.ciphertext);
      assert.equal("title" in saved.wire, false);
      assert.ok(!diagnostics().includes(brief));
      assert.ok(!diagnostics().includes(title));
      evidence.push({ chatId, title });
    }
    const directories = await readdir(profiles);
    const captured = await Promise.all(
      directories.map(async (id) => ({
        input: JSON.parse(
          await readFile(path.join(profiles, id, "fixture-input"), "utf8"),
        ),
        args: (
          await readFile(path.join(profiles, id, "fixture-arguments"), "utf8")
        ).split("\n"),
      })),
    );
    assert.deepEqual(captured.map(({ input }) => input.initialRequest).sort(), [
      "Count orchard crates",
      "Review the garden notes",
    ]);
    for (const { args } of captured) {
      assert.equal(args[args.indexOf("--tools") + 1], "");
      assert.ok(args.includes("--safe-mode"));
      assert.ok(args.includes("--model=sonnet"));
    }
    assert.equal(
      taskModel.requests.filter(({ method }) => method === "POST").length,
      0,
    );
    result.claudeLabel = { evidence, workerProfiles: directories.length };
    result.steps.push(
      "The production Task label command uses each selected worker-local Claude Code subprocess and persists only an encrypted label.",
    );
  } finally {
    await taskModel.close();
  }
}
