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
  assert.match(
    workflow,
    /artifacts\/bundles\/darwin-arm64\/\*\.app\.tar\.gz\.sig/u,
  );
  assert.match(workflow, /artifacts\/bundles\/win32-x64\/\*-setup\.exe/u);
  assert.match(workflow, /artifacts\/bundles\/win32-x64\/\*-setup\.exe\.sig/u);
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

test("fails closed while signing and notarizing the macOS updater and DMG", async () => {
  const workflow = await readFile(
    path.join(root, ".github", "workflows", "native-release.yml"),
    "utf8",
  );

  assert.match(workflow, /- name: Import macOS Developer ID certificate/u);
  assert.match(workflow, /APPLE_CERTIFICATE/u);
  assert.match(workflow, /Developer ID Application/u);
  assert.match(
    workflow,
    /security list-keychains -d user -s "\$keychain" "\$\{existing_keychains\[@\]\}"/u,
  );
  assert.doesNotMatch(
    workflow,
    /security default-keychain -s "\$keychain"/u,
  );
  assert.match(workflow, /DeveloperIDCA\.cer/u);
  assert.match(workflow, /DeveloperIDG2CA\.cer/u);
  assert.match(
    workflow,
    /7afc9d01a62f03a2de9637936d4afe68090d2de18d03f29c88cfb0b1ba63587f/u,
  );
  assert.match(
    workflow,
    /f16cd3c54c7f83cea4bf1a3e6a0819c8aaa8e4a1528fd144715f350643d2df3a/u,
  );
  assert.match(workflow, /leaf_fingerprint/u);
  assert.match(workflow, /CANTRIP_REQUIRE_MACOS_SIGNING: "1"/u);
  assert.match(workflow, /APPSTORE_CONNECT_ISSUER_ID/u);
  assert.match(workflow, /APPSTORE_CONNECT_KEY_ID/u);
  assert.match(workflow, /APPSTORE_CONNECT_KEY/u);
  assert.match(workflow, /CANTRIP_REQUIRE_MACOS_NOTARIZATION: "1"/u);
  assert.doesNotMatch(workflow, /CANTRIP_ALLOW_ADHOC_MACOS_SIGNING/u);
});

test("requires updater secrets and publishes the static manifest last", async () => {
  const workflow = await readFile(
    path.join(root, ".github", "workflows", "native-release.yml"),
    "utf8",
  );

  assert.match(
    workflow,
    /TAURI_SIGNING_PRIVATE_KEY: \$\{\{ secrets\.TAURI_SIGNING_PRIVATE_KEY \}\}/u,
  );
  assert.match(
    workflow,
    /TAURI_SIGNING_PRIVATE_KEY_PASSWORD: \$\{\{ secrets\.TAURI_SIGNING_PRIVATE_KEY_PASSWORD \}\}/u,
  );
  assert.match(workflow, /generate-updater-manifest\.mjs/u);
  assert.match(workflow, /releases\/generate-notes/u);
  assert.match(workflow, /--notes-file "\$release_notes"/u);
  const assetsUpload = workflow.lastIndexOf(
    'gh release upload "$tag" "${files[@]}" --clobber',
  );
  const manifestUpload = workflow.lastIndexOf(
    'gh release upload "$tag" release-assets/latest.json --clobber',
  );
  assert.ok(assetsUpload >= 0);
  assert.ok(manifestUpload > assetsUpload);
});

test("builds generated desktop dependencies before packaging installers", async () => {
  const workflow = await readFile(
    path.join(root, ".github", "workflows", "native-release.yml"),
    "utf8",
  );

  const protocolBuild = workflow.indexOf(
    "- name: Build desktop workspace dependencies",
  );
  const macosPackage = workflow.indexOf(
    "- name: Package signed and notarized macOS updater and DMG",
  );
  const windowsPackage = workflow.indexOf(
    "- name: Package signed Windows NSIS updater and installer",
  );
  assert.ok(protocolBuild >= 0);
  assert.match(
    workflow.slice(protocolBuild, macosPackage),
    /pnpm --filter @cantrip\/protocol build/u,
  );
  assert.ok(macosPackage > protocolBuild);
  assert.ok(windowsPackage > protocolBuild);
});
