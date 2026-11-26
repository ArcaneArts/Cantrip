import assert from "node:assert/strict";
import { eventually } from "./full-worker.mjs";
import { modelFunctions, taskModelProvider } from "./task-model-provider.mjs";

const rootName = "Council fixture root";
const childName = "Council fixture subagent";
const childModel = "gpt-5.4-mini";
const reasoning = {
  capabilities: { reasoning: { allowed_options: ["low", "medium", "high"] } },
};
const requestText = "Check the release with a native subagent.";
const childTask = "Report whether the fixture release is ready.";

export async function actualCouncilModels({ page, result, workerId }) {
  const model = await taskModelProvider({
    modelMetadata: reasoning,
    additionalModels: [{ id: childModel, ...reasoning }],
  });
  const timeout = 60_000;
  try {
    const profiles = await page.evaluate(
      async ({
        baseUrl,
        workerId,
        rootName,
        rootModel,
        childName,
        childModel,
      }) => {
        const models = await import("/src/lib/api/models.ts");
        const provider = await models.createModelProvider({
          name: "Council configuration fixture provider",
          kind: "openai-compatible",
          baseUrl,
          apiKey: null,
        });
        await models.refreshProviderModelCatalog(provider.id, workerId);
        const profile = (name, modelName) =>
          models.createModelProfile({
            name,
            routes: [{ providerId: provider.id, modelName, enabled: true }],
          });
        const root = await profile(rootName, rootModel);
        const child = await profile(childName, childModel);
        return { root: root.id, child: child.id };
      },
      {
        baseUrl: model.baseUrl,
        workerId,
        rootName,
        rootModel: model.model,
        childName,
        childModel,
      },
    );

    await page.getByRole("button", { name: "Open settings" }).click();
    await page.getByRole("button", { name: "Models", exact: true }).click();
    const defaultLabel = "Council default model configuration";
    await page.getByRole("button", { name: defaultLabel }).click();
    const defaults = page.getByRole("dialog", { name: defaultLabel });
    const choose = async (dialog, label, name) => {
      await dialog.getByRole("combobox", { name: label }).click();
      await page.getByRole("option", { name }).click();
    };
    const effort = (dialog, name) =>
      dialog.getByRole("slider", { name }).and(page.locator(":enabled"));
    const save = async (dialog) => {
      await dialog.getByRole("button", { name: "Save configuration" }).click();
      await dialog.waitFor({ state: "hidden", timeout });
    };
    await choose(defaults, "Root model", rootName);
    await effort(defaults, "Root reasoning effort").press("End");
    await defaults
      .getByRole("checkbox", { name: /Custom Subagent Model/u })
      .check();
    await choose(defaults, "Subagent model", childName);
    await effort(defaults, "Subagent reasoning effort").press("End");
    await effort(defaults, "Subagent reasoning effort").press("Home");
    await effort(defaults, "Subagent reasoning effort").press("ArrowRight");
    await save(defaults);
    const preferences = () =>
      page.evaluate(
        async () =>
          (await (await import("/src/lib/api/settings.ts")).getSettings())
            .preferences,
      );
    const saved = await preferences();
    assert.equal(saved.defaultCouncilModelId, profiles.root);
    assert.equal(saved.defaultCouncilReasoningEffort, "high");
    assert.equal(saved.defaultCouncilCustomSubagentModel, true);
    assert.equal(saved.defaultCouncilSubagentModelId, profiles.child);
    assert.equal(saved.defaultCouncilSubagentReasoningEffort, "low");

    await page.getByRole("button", { name: "Back to Chat" }).click();
    const roster = page.getByRole("navigation", { name: "Council agents" });
    await roster.getByRole("button", { name: "New agent" }).click();
    const create = page.getByRole("dialog", { name: "New Council agent" });
    await create.getByLabel("Name").fill("Claire");
    await create.getByLabel("Role").fill("Release chief of staff");
    const created = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/council/agents",
    );
    await create.getByRole("button", { name: "Create agent" }).click();
    assert.equal((await created).status(), 202);
    await roster
      .getByRole("button", { name: "Claire" })
      .getByText("Release chief of staff")
      .waitFor();
    const agentId = await page.evaluate(
      async () =>
        (
          await (await import("/src/lib/api/council.ts")).listCouncilAgents()
        ).find(({ title }) => title === "Claire")?.id,
    );
    assert.ok(agentId);
    const chat = () =>
      page.evaluate(
        async (id) =>
          (await import("/src/lib/api/council.ts")).getCouncilChat(id),
        agentId,
      );
    const copied = await chat();
    assert.equal(copied.modelId, profiles.root);
    assert.equal(copied.reasoningEffort, "high");
    assert.equal(copied.customSubagentModel, true);
    assert.equal(copied.subagentModelId, profiles.child);
    assert.equal(copied.subagentReasoningEffort, "low");

    await page.getByRole("button", { name: "Configure agent models" }).click();
    const perAgent = page.getByRole("dialog", {
      name: "Model configuration",
      exact: true,
    });
    await effort(perAgent, "Root reasoning effort").press("ArrowLeft");
    await effort(perAgent, "Subagent reasoning effort").press("End");
    await save(perAgent);
    assert.equal((await chat()).reasoningEffort, "medium");
    assert.equal((await chat()).subagentReasoningEffort, "high");
    assert.equal(
      (await preferences()).defaultCouncilSubagentReasoningEffort,
      "low",
    );

    const spawn = model.reply({
      responseId: "council-fixture-spawn",
      hold: true,
    });
    model.reply({ text: "The release fixture is ready." });
    model.reply({ text: "The release fixture is ready." });
    try {
      await page.getByPlaceholder("Message Cantrip…").fill(requestText);
      await page.getByRole("button", { name: "Send prompt" }).click();
      const active = await eventually(
        () => spawn.request,
        (request) => assert.ok(request),
        timeout,
      );
      assert.equal(active.input.model, model.model);
      assert.equal(active.input.reasoning?.effort, "medium");
      const tool = modelFunctions(active.input.tools).find(
        ({ name }) => name === "spawn_agent" || name.endsWith("__spawn_agent"),
      );
      assert.ok(tool, "Council exposes the native spawn_agent tool.");
      const legacy =
        tool.namespace === "multi_agent_v1" ||
        tool.name.startsWith("multi_agent_v1__");
      spawn.calls = [
        {
          ...tool,
          arguments: legacy
            ? { message: childTask, fork_context: false }
            : {
                message: childTask,
                task_name: "release_check",
                fork_turns: "none",
              },
        },
      ];
      spawn.release();
      await eventually(
        () =>
          model.requests.find(
            ({ input }) =>
              input?.model === childModel &&
              input?.reasoning?.effort === "high" &&
              JSON.stringify(input.input).includes(childTask),
          ),
        (request) =>
          assert.ok(request?.completed, JSON.stringify(model.failures)),
        timeout,
      );
      await eventually(
        chat,
        (state) => assert.equal(state.status, "idle"),
        timeout,
      );
      assert.deepEqual(model.failures, []);
    } finally {
      spawn.release();
    }
    result.steps.push(
      "Council displays the role, keeps the sidebar footer at the bottom, saves root and subagent defaults, and runs a real subagent with the selected model and reasoning.",
    );
  } finally {
    await model.close();
  }
}
