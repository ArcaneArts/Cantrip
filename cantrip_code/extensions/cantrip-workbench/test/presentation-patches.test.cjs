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
  assert.match(source, /case Parts\.SIDEBAR_PART:/u);
  assert.match(source, /case Parts\.PANEL_PART:/u);
  assert.match(source, /case Parts\.AUXILIARYBAR_PART:/u);
  assert.match(source, /case Parts\.STATUSBAR_PART:/u);
  assert.match(source, /case Parts\.ACTIVITYBAR_PART:/u);
  assert.equal(
    source.match(
      /hidden = hidden \|\| isCantripEditorPresentation\(this\.configurationService\);/gu,
    )?.length,
    5,
  );
  assert.match(
    source,
    /this\.stateCache\.set\(LayoutStateKeys\.EDITOR_HIDDEN\.name, false\);/u,
  );
  assert.match(source, /options\.showTabs = 'none';/u);
  assert.match(source, /options\.editorActionsLocation = 'hidden';/u);
  assert.match(
    source,
    /!isCantripEditorPresentation\(configurationService\) && config\.getValue\(\)/u,
  );
  assert.match(
    source,
    /event\.affectsConfiguration\(LayoutSettings\.CANTRIP_PRESENTATION\)/u,
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
