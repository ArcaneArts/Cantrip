import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  defaultAppPlatformAppId,
  deployAppPlatform,
  parseAppPlatformApp,
  verifyAppPlatformRelease,
} from "./deploy-app-platform.mjs";

const appSpecUrl = new URL("../.do/app.yaml", import.meta.url);
const commit = "a".repeat(40);

function appPlatformApp(activeCommit = commit) {
  return {
    id: defaultAppPlatformAppId,
    active_deployment: {
      id: "deployment-one",
      phase: "ACTIVE",
      static_sites: [
        { name: "app", source_commit_hash: activeCommit },
        { name: "site", source_commit_hash: activeCommit },
      ],
    },
  };
}

test("App Platform static sites use browser-only build commands", async () => {
  const spec = await readFile(appSpecUrl, "utf8");

  assert.match(
    spec,
    /^\s{4}build_command: pnpm --filter @cantrip\/version build && pnpm --filter @cantrip\/logging build && pnpm --filter @cantrip\/protocol build && pnpm --filter @cantrip\/crypto build && pnpm --filter @cantrip\/app build$/mu,
  );
  assert.match(
    spec,
    /^\s{4}build_command: pnpm --filter @cantrip\/site build$/mu,
  );
  assert.doesNotMatch(spec, /^\s{4}build_command: pnpm (?:run )?build$/mu);
});

test("verifies both App Platform surfaces activated the release commit", () => {
  const app = appPlatformApp();
  assert.deepEqual(parseAppPlatformApp(JSON.stringify([app])), app);
  assert.deepEqual(verifyAppPlatformRelease(app, commit), {
    appId: defaultAppPlatformAppId,
    commit,
    components: ["app", "site"],
    deploymentId: "deployment-one",
  });
  assert.throws(
    () => verifyAppPlatformRelease(appPlatformApp("b".repeat(40)), commit),
    /did not activate/u,
  );
});

test("updates App Platform sources, waits, and verifies the active deployment", () => {
  const calls = [];
  const deployment = deployAppPlatform({
    appId: defaultAppPlatformAppId,
    commit,
    root: "/workspace/cantrip",
    run(commandName, arguments_, options) {
      calls.push({ arguments_, commandName, options });
      return {
        stderr: "",
        stdout:
          arguments_[1] === "get" ? JSON.stringify([appPlatformApp()]) : "",
      };
    },
  });

  assert.equal(deployment.commit, commit);
  assert.deepEqual(
    calls.map(({ commandName, arguments_ }) => [commandName, ...arguments_]),
    [
      ["doctl", "apps", "spec", "validate", "/workspace/cantrip/.do/app.yaml"],
      [
        "doctl",
        "apps",
        "update",
        defaultAppPlatformAppId,
        "--spec",
        "/workspace/cantrip/.do/app.yaml",
        "--update-sources",
        "--wait",
      ],
      ["doctl", "apps", "get", defaultAppPlatformAppId, "--output", "json"],
    ],
  );
});

test("can trigger an App Platform deployment without waiting for activation", () => {
  const calls = [];
  const deployment = deployAppPlatform({
    appId: defaultAppPlatformAppId,
    commit,
    root: "/workspace/cantrip",
    waitForActivation: false,
    run(commandName, arguments_, options) {
      calls.push({ arguments_, commandName, options });
      return { stderr: "", stdout: "" };
    },
  });

  assert.deepEqual(deployment, {
    appId: defaultAppPlatformAppId,
    commit,
    components: ["app", "site"],
    pending: true,
  });
  assert.deepEqual(
    calls.map(({ commandName, arguments_ }) => [commandName, ...arguments_]),
    [
      ["doctl", "apps", "spec", "validate", "/workspace/cantrip/.do/app.yaml"],
      [
        "doctl",
        "apps",
        "update",
        defaultAppPlatformAppId,
        "--spec",
        "/workspace/cantrip/.do/app.yaml",
        "--update-sources",
      ],
    ],
  );
});
