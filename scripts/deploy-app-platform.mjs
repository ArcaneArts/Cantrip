import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export const defaultAppPlatformAppId = "81fa8bbd-668f-4c1f-848c-7b49442af6b2";
export const appPlatformComponents = Object.freeze(["app", "site"]);

function command(commandName, arguments_, options = {}) {
  const result = spawnSync(commandName, arguments_, {
    cwd: options.cwd ?? scriptRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    if (result.error.code === "ENOENT" && commandName === "doctl") {
      throw new Error(
        "DigitalOcean App Platform deployment requires the authenticated doctl CLI.",
      );
    }
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(
      `${commandName} ${arguments_.join(" ")} failed${detail ? `: ${detail}` : "."}`,
    );
  }
  return {
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
  };
}

export function parseAppPlatformApp(output) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("doctl returned malformed App Platform JSON.");
  }
  const app = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!app || typeof app !== "object") {
    throw new Error("doctl did not return an App Platform app.");
  }
  return app;
}

export function verifyAppPlatformRelease(
  app,
  expectedCommit,
  requiredComponents = appPlatformComponents,
) {
  if (!/^[0-9a-f]{40}$/u.test(expectedCommit)) {
    throw new Error("App Platform deployment requires a full Git commit SHA.");
  }
  const deployment = app.active_deployment;
  if (!deployment || deployment.phase !== "ACTIVE") {
    throw new Error("DigitalOcean App Platform has no active deployment.");
  }
  const componentCommits = new Map(
    (deployment.static_sites ?? []).map((component) => [
      component.name,
      component.source_commit_hash,
    ]),
  );
  const staleComponents = requiredComponents.filter(
    (name) => componentCommits.get(name) !== expectedCommit,
  );
  if (staleComponents.length > 0) {
    const activeCommits = staleComponents
      .map((name) => `${name}=${componentCommits.get(name) ?? "missing"}`)
      .join(", ");
    throw new Error(
      `DigitalOcean App Platform did not activate ${expectedCommit.slice(0, 12)} for ${staleComponents.join(", ")} (${activeCommits}).`,
    );
  }
  return {
    appId: app.id,
    commit: expectedCommit,
    components: [...requiredComponents],
    deploymentId: deployment.id,
  };
}

export function deployAppPlatform({
  appId = process.env.CANTRIP_DIGITALOCEAN_APP_ID?.trim() ||
    defaultAppPlatformAppId,
  commit,
  root = scriptRoot,
  run = command,
} = {}) {
  if (!/^[0-9a-f]{40}$/u.test(commit ?? "")) {
    throw new Error("App Platform deployment requires a full Git commit SHA.");
  }
  if (!/^[0-9a-f-]{36}$/u.test(appId)) {
    throw new Error("CANTRIP_DIGITALOCEAN_APP_ID must be a UUID.");
  }
  const specPath = path.join(root, ".do", "app.yaml");
  run("doctl", ["apps", "spec", "validate", specPath], {
    cwd: root,
    inherit: true,
  });
  run(
    "doctl",
    ["apps", "update", appId, "--spec", specPath, "--update-sources", "--wait"],
    { cwd: root, inherit: true },
  );
  const app = parseAppPlatformApp(
    run("doctl", ["apps", "get", appId, "--output", "json"], {
      cwd: root,
    }).stdout,
  );
  const deployment = verifyAppPlatformRelease(app, commit);
  console.log(
    `DigitalOcean App Platform activated ${commit.slice(0, 12)} for ${deployment.components.join(" and ")}.`,
  );
  return deployment;
}
