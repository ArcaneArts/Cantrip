import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("publishes native releases only when the release branch advances", async () => {
  const workflow = await readFile(
    path.join(root, ".github", "workflows", "native-release.yml"),
    "utf8",
  );

  assert.match(workflow, /^on:\n {2}push:\n {4}branches:\n {6}- release$/mu);
  assert.doesNotMatch(workflow, /^\s*(?:pull_request|workflow_dispatch):/mu);
  assert.match(workflow, /blacksmith-6vcpu-macos-15/u);
  assert.match(workflow, /blacksmith-8vcpu-windows-2025/u);
});

test("caches verified heavyweight runtimes and publishes the requested assets", async () => {
  const workflow = await readFile(
    path.join(root, ".github", "workflows", "native-release.yml"),
    "utf8",
  );

  assert.match(
    workflow,
    /cantrip_codex\/\.build\/\$\{\{ matrix\.target \}\}\/bundle/u,
  );
  assert.match(
    workflow,
    /\.cantrip-code\/cache\/builds\/\$\{\{ matrix\.target \}\}\/\$\{\{ steps\.code-fingerprint\.outputs\.value \}\}/u,
  );
  assert.match(workflow, /CANTRIP_WINDOWS_BUNDLE: nsis/u);
  assert.match(workflow, /artifacts\/bundles\/darwin-arm64\/\*\.dmg/u);
  assert.match(workflow, /artifacts\/bundles\/win32-x64\/\*\.exe/u);
  assert.match(workflow, /cantrip-server-\$\{\{ matrix\.target \}\}\.tar\.gz/u);
  assert.match(workflow, /cantrip-worker-\$\{\{ matrix\.target \}\}\.tar\.gz/u);
  assert.match(workflow, /version="\$\(node scripts\/version\.mjs\)"/u);
  assert.match(workflow, /tag="v\$\{version\}"/u);
});

test("saves Codex before building Cantrip Code", async () => {
  const workflow = await readFile(
    path.join(root, ".github", "workflows", "native-release.yml"),
    "utf8",
  );

  const codexBuild = workflow.indexOf("- name: Build Codex runtime");
  const codexSave = workflow.indexOf("- name: Save verified Codex runtime");
  const codeBuild = workflow.indexOf("- name: Build Cantrip Code");
  assert.ok(codexBuild >= 0);
  assert.ok(codexSave > codexBuild);
  assert.ok(codeBuild > codexSave);
  assert.match(workflow, /uses: actions\/cache\/restore@v4/u);
  assert.match(workflow, /uses: actions\/cache\/save@v4/u);
});

test("installs the native libraries required by Windows Code modules", async () => {
  const workflow = await readFile(
    path.join(root, ".github", "workflows", "native-release.yml"),
    "utf8",
  );

  assert.match(
    workflow,
    /Microsoft\.VisualStudio\.Component\.VC\.Runtimes\.x86\.x64\.Spectre/u,
  );
  assert.match(workflow, /setup\.exe/u);
  assert.match(workflow, /Visual Studio Spectre libraries found at/u);
});

test("signs the macOS DMG without invoking Apple notarization", async () => {
  const workflow = await readFile(
    path.join(root, ".github", "workflows", "native-release.yml"),
    "utf8",
  );

  assert.match(workflow, /- name: Import macOS signing certificate/u);
  assert.match(workflow, /APPLE_CERTIFICATE/u);
  assert.match(workflow, /CANTRIP_REQUIRE_MACOS_SIGNING: "1"/u);
  assert.doesNotMatch(workflow, /APPSTORE_CONNECT_/u);
  assert.doesNotMatch(workflow, /CANTRIP_REQUIRE_MACOS_NOTARIZATION/u);
  assert.doesNotMatch(workflow, /Developer ID Application/u);
});

test("builds generated desktop dependencies before packaging installers", async () => {
  const workflow = await readFile(
    path.join(root, ".github", "workflows", "native-release.yml"),
    "utf8",
  );

  const protocolBuild = workflow.indexOf(
    "- name: Build desktop workspace dependencies",
  );
  const macosPackage = workflow.indexOf("- name: Package signed macOS DMG");
  const windowsPackage = workflow.indexOf(
    "- name: Package Windows NSIS installer",
  );
  assert.ok(protocolBuild >= 0);
  assert.match(
    workflow.slice(protocolBuild, macosPackage),
    /pnpm --filter @cantrip\/protocol build/u,
  );
  assert.ok(macosPackage > protocolBuild);
  assert.ok(windowsPackage > protocolBuild);
});
