import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chatPermissionProfileStateSchema } from "../../packages/protocol/dist/index.js";
import { createPreparedProjectChat } from "./console-interaction-cases.mjs";

export async function verifyPermissionProfiles({
  call,
  eventually,
  createModel,
  createChat,
  ownerId,
  workerId,
  keyRevision,
  labelKey,
  data,
}) {
  const model = await createModel("Native permission profile fixture");
  await call("PATCH", "/api/settings", 200, {
    defaultModelId: model.profile.id,
  });

  const runtimeHome = path.join(data, "codex-home");
  await mkdir(runtimeHome, { recursive: true });
  const configuredProfiles = Array.from({ length: 101 }, (_, index) => {
    const id = "cantrip-audit-" + index.toString().padStart(3, "0");
    const description = index === 100 ? "Second page inspection profile" : "";
    return { id, description, allowed: true };
  });
  const config = configuredProfiles
    .map(({ id, description }) =>
      [
        "[permissions." + id + "]",
        'extends = ":read-only"',
        ...(description
          ? ["description = " + JSON.stringify(description)]
          : []),
      ].join("\n"),
    )
    .join("\n\n");

  const project = await createPreparedProjectChat({
    call,
    eventually,
    ownerId,
    workerId,
    keyRevision,
    labelKey,
    title: "Checkout permission profile discovery",
    async beforeChat({ projectId, workspaceId }) {
      const projectPath = path.join(
        data,
        "workspaces",
        workspaceId,
        "folders",
        projectId,
      );
      const workspaceConfiguration = path.join(projectPath, ".codex");
      await mkdir(workspaceConfiguration);
      await writeFile(
        path.join(workspaceConfiguration, "config.toml"),
        '[permissions.checkout-audit]\nextends = ":read-only"\ndescription = "Trusted checkout audit profile"\n',
      );
      await writeFile(
        path.join(runtimeHome, "config.toml"),
        'default_permissions = ":workspace"\n\n' +
          "[projects." +
          JSON.stringify(projectPath) +
          ']\ntrust_level = "trusted"\n\n' +
          config +
          "\n",
      );
    },
  });
  const standalone = await createChat(
    "Standalone permission profile discovery",
    false,
  );

  async function profiles({ chatUrl }) {
    const result = chatPermissionProfileStateSchema.parse(
      await call("GET", chatUrl + "/permission-profiles", 200),
    );
    assert.equal(result.available, true, JSON.stringify(result));
    assert.equal(result.reason, null);
    assert.deepEqual(
      result.profiles.filter(({ id }) => id.startsWith("cantrip-audit-")),
      configuredProfiles,
    );
    assert.deepEqual(
      result.profiles.find(({ id }) => id === ":read-only"),
      {
        id: ":read-only",
        description: "",
        allowed: true,
      },
    );
    assert.equal(
      result.profiles.find(({ id }) => id === ":yolo")?.allowed,
      true,
    );
    return result.profiles;
  }

  assert.deepEqual(
    (await profiles(project)).find(({ id }) => id === "checkout-audit"),
    {
      id: "checkout-audit",
      description: "Trusted checkout audit profile",
      allowed: true,
    },
  );
  assert.equal(
    (await profiles(standalone)).some(({ id }) => id === "checkout-audit"),
    false,
  );
  assert.equal(
    model.model.requests.filter(({ method }) => method === "POST").length,
    0,
  );
  console.log(
    JSON.stringify({ suite: "native-permission-profiles", passed: true }),
  );
}
