import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readWorkflow() {
  const workflow = await readFile(
    path.join(root, ".github", "workflows", "native-release.yml"),
    "utf8",
  );
  return workflow.replace(/\r\n/g, "\n");
}

test("publishes native releases only when the release branch advances", async () => {
  const workflow = await readWorkflow();
  assert.match(workflow, /^on:\n {2}push:\n {4}branches:\n {6}- release$/mu);
  assert.doesNotMatch(workflow, /^\s*(?:pull_request|workflow_dispatch):/mu);
  assert.match(workflow, /blacksmith-6vcpu-macos-15/u);
  assert.match(workflow, /blacksmith-8vcpu-windows-2025/u);
});

test("caches verified heavyweight runtimes and publishes the requested assets", async () => {
  const workflow = await readWorkflow();

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

test("smokes the packaged worker MCP on macOS and Windows before archiving", async () => {
  const workflow = await readWorkflow();
  const workerJob =
    workflow.match(/^ {2}worker:[\s\S]*?(?=^ {2}\w+:)/mu)?.[0] ?? "";
  assert.match(workerJob, /target: darwin-arm64/u);
  assert.match(workerJob, /target: win32-x64/u);
  const packageStep = workerJob.indexOf(
    "- name: Package worker from verified runtimes",
  );
  const verifyStep = workerJob.indexOf("- name: Verify packaged worker MCP");
  const archiveStep = workerJob.indexOf("archive-distribution.mjs worker");
  assert.ok(packageStep >= 0);
  assert.ok(verifyStep > packageStep);
  assert.ok(archiveStep > verifyStep);
  assert.match(
    workerJob,
    /verify-packaged-worker-mcp\.mjs artifacts\/cantrip-worker-\$\{\{ matrix\.target \}\}/u,
  );
});

test("builds mobile releases in parallel and gates publication on them", async () => {
  const workflow = await readWorkflow();

  assert.match(workflow, /^ {2}android:\n {4}name: Android signed release$/mu);
  assert.match(workflow, /^ {2}ios:\n {4}name: iOS TestFlight$/mu);
  assert.equal(
    workflow.match(/pnpm --filter @cantrip\/logging build/gmu)?.length,
    3,
  );
  assert.equal(
    workflow.match(/pnpm --filter @cantrip\/crypto build/gmu)?.length,
    3,
  );
  assert.equal(
    workflow.match(/pnpm --filter @cantrip\/version build/gmu)?.length,
    3,
  );
  const androidJob =
    workflow.match(/^ {2}android:[\s\S]*?(?=^ {2}\w+:)/mu)?.[0] ?? "";
  const iosJob = workflow.match(/^ {2}ios:[\s\S]*?(?=^ {2}\w+:)/mu)?.[0] ?? "";
  const clientJob =
    workflow.match(/^ {2}client:[\s\S]*?(?=^ {2}\w+:)/mu)?.[0] ?? "";
  assert.match(androidJob, /pnpm --filter @cantrip\/version build/u);
  assert.match(iosJob, /pnpm --filter @cantrip\/version build/u);
  assert.match(androidJob, /pnpm --filter @cantrip\/crypto build/u);
  assert.match(iosJob, /pnpm --filter @cantrip\/crypto build/u);
  assert.match(androidJob, /pnpm verify:installation-compatibility/u);
  assert.match(iosJob, /pnpm verify:installation-compatibility/u);
  assert.match(clientJob, /pnpm verify:installation-compatibility/u);
  assert.match(
    androidJob,
    /:app:testDebugUnitTest --tests art\.cantrip\.CantripInstallationStorageUpdateTest/u,
  );
  assert.match(iosJob, /node --test scripts\/ios-native-storage\.test\.mjs/u);
  assert.match(
    clientJob,
    /frozen_version_one_fixture_opens_and_decrypts_with_current_runtime/u,
  );
  assert.doesNotMatch(androidJob, /^ {4}needs:/mu);
  assert.doesNotMatch(iosJob, /^ {4}needs:/mu);
  assert.match(workflow, /needs: \[server, worker, client, android, ios\]/u);
});

test("publishes signed Android artifacts and uploads iOS to TestFlight", async () => {
  const workflow = await readWorkflow();
  const androidBuild = await readFile(
    path.join(root, "cantrip_app", "android", "app", "build.gradle"),
    "utf8",
  );
  const exportOptions = await readFile(
    path.join(
      root,
      "cantrip_app",
      "ios",
      "App",
      "TestFlightExportOptions.plist",
    ),
    "utf8",
  );

  assert.match(workflow, /ANDROID_UPLOAD_KEYSTORE_BASE64/u);
  assert.match(workflow, /CANTRIP_ANDROID_UPLOAD_KEYSTORE_PATH/u);
  assert.match(
    workflow,
    /\.\/gradlew --no-daemon bundleRelease assembleRelease/u,
  );
  assert.match(workflow, /jarsigner -verify "\$bundle"/u);
  assert.match(workflow, /Cantrip_\$\{version\}_android\.aab/u);
  assert.match(workflow, /Cantrip_\$\{version\}_android\.apk/u);
  assert.match(workflow, /name: cantrip-android-release/u);
  assert.match(workflow, /Remove Android upload keystore/u);
  assert.match(androidBuild, /signingConfigs/u);
  assert.match(androidBuild, /CANTRIP_ANDROID_UPLOAD_KEYSTORE_PATH/u);
  assert.match(androidBuild, /Android release signing requires/u);
  assert.match(workflow, /IOS_DISTRIBUTION_CERTIFICATE/u);
  assert.match(workflow, /^ {4}runs-on: macos-26$/mu);
  assert.match(workflow, /xcrun --sdk iphoneos --show-sdk-version/u);
  assert.match(workflow, /sdk_major < 26/u);
  assert.match(workflow, /Apple Distribution/u);
  assert.match(workflow, /-archivePath "\$RUNNER_TEMP\/Cantrip\.xcarchive"/u);
  assert.match(
    workflow,
    /-exportOptionsPlist cantrip_app\/ios\/App\/TestFlightExportOptions\.plist/u,
  );
  assert.match(workflow, /APPSTORE_CONNECT_ISSUER_ID/u);
  assert.match(workflow, /APPSTORE_CONNECT_KEY_ID/u);
  assert.match(workflow, /APPSTORE_CONNECT_KEY/u);
  assert.match(exportOptions, /<string>upload<\/string>/u);
  assert.match(exportOptions, /<string>app-store-connect<\/string>/u);
});

test("reuses matching iOS development and distribution identities", async () => {
  const workflow = await readWorkflow();

  assert.match(
    workflow,
    /IOS_DEVELOPMENT_CERTIFICATE: \$\{\{ secrets\.IOS_DEVELOPMENT_CERTIFICATE \}\}/u,
  );
  assert.match(
    workflow,
    /IOS_DEVELOPMENT_CERTIFICATE_PASSWORD: \$\{\{ secrets\.IOS_DEVELOPMENT_CERTIFICATE_PASSWORD \}\}/u,
  );
  assert.match(workflow, /security import "\$development_certificate"/u);
  assert.match(workflow, /security import "\$distribution_certificate"/u);
  assert.match(workflow, /grep -q 'Apple Development:'/u);
  assert.match(workflow, /grep -q 'Apple Distribution:'/u);
  assert.match(workflow, /"\$development_team_id" != "\$team_id"/u);
});

test("saves Codex before building Cantrip Code", async () => {
  const workflow = await readWorkflow();

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
  const workflow = await readWorkflow();

  assert.match(
    workflow,
    /Microsoft\.VisualStudio\.Component\.VC\.Runtimes\.x86\.x64\.Spectre/u,
  );
  assert.match(workflow, /setup\.exe/u);
  assert.match(workflow, /Visual Studio Spectre libraries found at/u);
});

test("fails closed while signing and notarizing the macOS updater and DMG", async () => {
  const workflow = await readWorkflow();

  const importer = await readFile(
    path.join(root, "scripts", "import-macos-developer-id.sh"),
    "utf8",
  );
  assert.match(workflow, /- name: Import macOS Developer ID certificate/u);
  assert.match(workflow, /APPLE_CERTIFICATE/u);
  assert.match(workflow, /run: bash scripts\/import-macos-developer-id\.sh/u);
  assert.match(importer, /Developer ID Application/u);
  assert.match(
    importer,
    /security list-keychains -d user -s "\$keychain" "\$\{existing_keychains\[@\]\}"/u,
  );
  assert.doesNotMatch(importer, /security default-keychain/u);
  assert.match(importer, /DeveloperIDCA\.cer/u);
  assert.match(importer, /DeveloperIDG2CA\.cer/u);
  assert.match(
    importer,
    /7afc9d01a62f03a2de9637936d4afe68090d2de18d03f29c88cfb0b1ba63587f/u,
  );
  assert.match(
    importer,
    /f16cd3c54c7f83cea4bf1a3e6a0819c8aaa8e4a1528fd144715f350643d2df3a/u,
  );
  assert.match(importer, /leaf_fingerprint/u);
  assert.match(workflow, /CANTRIP_REQUIRE_MACOS_SIGNING: "1"/u);
  assert.match(workflow, /APPSTORE_CONNECT_ISSUER_ID/u);
  assert.match(workflow, /APPSTORE_CONNECT_KEY_ID/u);
  assert.match(workflow, /APPSTORE_CONNECT_KEY/u);
  assert.match(workflow, /CANTRIP_REQUIRE_MACOS_NOTARIZATION: "1"/u);
  assert.doesNotMatch(workflow, /CANTRIP_ALLOW_ADHOC_MACOS_SIGNING/u);
});

test("requires updater secrets and publishes the static manifest last", async () => {
  const workflow = await readWorkflow();

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
  const workflow = await readWorkflow();

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
    /pnpm --filter @cantrip\/version build/u,
  );
  assert.match(
    workflow.slice(protocolBuild, macosPackage),
    /pnpm --filter @cantrip\/logging build/u,
  );
  assert.match(
    workflow.slice(protocolBuild, macosPackage),
    /pnpm --filter @cantrip\/protocol build/u,
  );
  assert.match(
    workflow.slice(protocolBuild, macosPackage),
    /pnpm --filter @cantrip\/crypto build/u,
  );
  assert.ok(macosPackage > protocolBuild);
  assert.ok(windowsPackage > protocolBuild);
});

test("signs the packaged macOS worker helper and verifies it before archive publication", async () => {
  const workflow = await readWorkflow();
  const worker =
    workflow.match(/^ {2}worker:[\s\S]*?(?=^ {2}\w+:)/mu)?.[0] ?? "";
  const steps = [
    "Package worker from verified runtimes",
    "Import macOS Developer ID certificate",
    "Sign standalone macOS worker CUA",
    "Verify signed packaged macOS worker CUA",
    "archive-distribution.mjs worker",
    "actions/upload-artifact@v4",
    "Remove temporary signing keychain",
  ].map((name) => worker.indexOf(name));
  assert.ok(
    steps.every(
      (position, index) =>
        position >= 0 && (index === 0 || position > steps[index - 1]),
    ),
  );
  assert.match(
    worker,
    /--binary artifacts\/cantrip-worker-\$\{\{ matrix\.target \}\}\/bin\/cantrip-cua --identity "\$APPLE_SIGNING_IDENTITY"/u,
  );
  assert.match(
    worker,
    /verify-packaged-worker-cua\.mjs artifacts\/cantrip-worker-\$\{\{ matrix\.target \}\} --require-developer-id/u,
  );
  for (const jobName of ["worker", "client"]) {
    const job =
      workflow.match(
        new RegExp(`^ {2}${jobName}:[\\s\\S]*?(?=^ {2}\\w+:)`, "mu"),
      )?.[0] ?? "";
    assert.match(
      job,
      /Import macOS Developer ID certificate\n {8}if: matrix.target == 'darwin-arm64'/u,
    );
    assert.match(
      job,
      /APPLE_CERTIFICATE: \$\{\{ secrets\.APPLE_CERTIFICATE \}\}/u,
    );
    assert.match(job, /run: bash scripts\/import-macos-developer-id\.sh/u);
    assert.match(
      job,
      /Remove temporary signing keychain\n {8}if: always\(\) && matrix.target == 'darwin-arm64'/u,
    );
    assert.match(job, /bash scripts\/import-macos-developer-id\.sh cleanup/u);
  }
  assert.match(
    worker,
    /Verify packaged Windows worker CUA\n {8}if: matrix.target == 'win32-x64'\n {8}run: node scripts\/verify-packaged-worker-cua\.mjs artifacts\/cantrip-worker-\$\{\{ matrix\.target \}\}\n/u,
  );
});
