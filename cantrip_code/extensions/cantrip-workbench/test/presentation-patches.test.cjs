"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");

function patch(name) {
  return readFileSync(
    path.resolve(__dirname, "../../../patches", `${name}.patch`),
    "utf8",
  );
}

test("makes every prohibited workbench part authoritative in editor presentation", () => {
  const source = patch("0007-honor-editor-presentation-layout");

  assert.match(source, /case Parts\.TITLEBAR_PART:/u);
  assert.doesNotMatch(source, /^\+\s+case Parts\.TITLEBAR_PART:/mu);
  assert.match(
    source,
    /part === Parts\.SIDEBAR_PART && isCantripEditorPresentation/u,
  );
  assert.match(source, /case Parts\.PANEL_PART:/u);
  assert.match(source, /case Parts\.AUXILIARYBAR_PART:/u);
  assert.match(source, /case Parts\.STATUSBAR_PART:/u);
  assert.match(source, /case Parts\.ACTIVITYBAR_PART:/u);
  assert.equal(
    source.match(
      /hidden = hidden \|\| isCantripEmbeddedPresentation\(this\.configurationService\);/gu,
    )?.length,
    4,
  );
  assert.match(
    source,
    /private setSideBarHidden\(hidden: boolean\): void \{\n\+\s*hidden = hidden \|\| isCantripEditorPresentation/u,
  );
  assert.match(
    source,
    /this\.stateCache\.set\(LayoutStateKeys\.EDITOR_HIDDEN\.name, false\);/u,
  );
  assert.match(source, /options\.showTabs = 'none';/u);
  assert.match(source, /options\.editorActionsLocation = 'hidden';/u);
  assert.match(
    source,
    /!isCantripEmbeddedPresentation\(configurationService\) && config\.getValue\(\)/u,
  );
  assert.match(
    source,
    /event\.affectsConfiguration\(LayoutSettings\.CANTRIP_PRESENTATION\)/u,
  );
  assert.match(
    source,
    /if \(isCantripEmbeddedPresentation\(configurationService\)\) \{\n\+\t\treturn false;/u,
  );
});

test("retains only extension-management surfaces in Extensions presentation", () => {
  const source = patch("0007-honor-editor-presentation-layout");

  assert.match(
    source,
    /presentation === 'editor' \|\| presentation === 'extensions'/u,
  );
  assert.match(
    source,
    /part === Parts\.SIDEBAR_PART && isCantripEditorPresentation/u,
  );
  assert.match(
    source,
    /isCantripEmbeddedPresentation\(this\.configurationService\)/u,
  );
  assert.doesNotMatch(
    source,
    /private addToast\(item: INotificationViewItem\): void \{\n\+\s*if \(isCantripEmbeddedPresentation/u,
  );
});

test("suppresses notification toasts throughout editor presentation", () => {
  const source = patch("0007-honor-editor-presentation-layout");

  assert.match(
    source,
    /private addToast\(item: INotificationViewItem\): void \{\n\+\t\tif \(isCantripEditorPresentation\(this\.configurationService\)\)/u,
  );
  assert.match(
    source,
    /event\.affectsConfiguration\(LayoutSettings\.CANTRIP_PRESENTATION\).*?this\.hide\(\);/su,
  );
});

test("signals readiness only from a restored embedded editor with a valid mount nonce", () => {
  const source = patch("0008-signal-embedded-workbench-readiness");

  assert.match(source, /mainWindow\.parent === mainWindow/u);
  assert.match(source, /querySelector\('\.part\.editor'\)/u);
  assert.match(source, /\^\[A-Za-z0-9_-\]\{16,128\}\$/u);
  assert.match(source, /type: 'cantrip-code\.workbench-ready'/u);
  assert.match(source, /version: 1/u);
  assert.match(
    source,
    /lifecycleService\.phase = LifecyclePhase\.Restored;\n\+\t\t\t\tsignalCantripWorkbenchReady\(\);/u,
  );
});

test("protects Cantrip-required extensions below the Extensions UI", () => {
  const source = patch("0010-protect-required-cantrip-extensions");

  assert.match(source, /cantrip\.cantrip-workbench/u);
  assert.match(source, /cantrip\.cantrip-themes/u);
  assert.match(source, /EnablementState\.EnabledByEnvironment/u);
  assert.match(source, /createInstallExtensionTask/u);
  assert.match(source, /createUninstallExtensionTask/u);
  assert.match(source, /addExtensionsToProfile/u);
  assert.match(source, /Cannot replace/u);
});
