import assert from "node:assert/strict";
import test from "node:test";
import {
  nativeRouteContentClassification,
  nativeTableClassifications,
  nativeWorkerCommandContentClassification,
} from "./native-content-classifications.mjs";

test("native receipts with preserved content remain endpoint-protected", () => {
  for (const path of [
    "/api/internal/native-history/resolve",
    "/api/internal/native-history/archive-turns",
    "/api/internal/native-queue/lookup",
    "/api/internal/native-queue/start-receipt",
    "/api/internal/native-runtime-handoffs",
    "/api/internal/native-runtime-handoffs/configuration",
    "/api/internal/native-commands/settings-evidence",
    "/api/chats/:chatId/native-account-defaults",
    "/api/chats/:chatId/native-settings/refresh",
    "/api/chats/:chatId/queue/operations/:operationId",
  ])
    assert.equal(
      nativeRouteContentClassification({ path })?.classification,
      "endpoint-protected",
      path,
    );
  for (const table of [
    "nativeRuntimeHandoffs",
    "nativeHistoryItems",
    "nativeHistoryReceipts",
    "nativeHistoryTurns",
    "managedQueueInputSnapshots",
    "nativeSettingsEvidence",
  ])
    assert.equal(
      nativeTableClassifications[table],
      "endpoint-protected",
      table,
    );
});

test("native authority metadata is distinct from content or execution", () => {
  for (const path of [
    "/api/chats/:chatId/preparation",
    "/api/internal/native-history/open",
    "/api/internal/native-commands/permission-transition",
  ])
    assert.equal(
      nativeRouteContentClassification({ path })?.classification,
      "intentionally-public-control-plane",
      path,
    );
  assert.equal(
    nativeWorkerCommandContentClassification("chat.permissions.update")
      ?.classification,
    "intentionally-public-control-plane",
  );
  assert.equal(
    nativeWorkerCommandContentClassification("chat.settings.update")
      ?.classification,
    "endpoint-protected",
  );
  assert.equal(
    nativeTableClassifications.nativeCommandActivations,
    "minimized-operational-metadata",
  );
});

test("native classifiers do not claim unreviewed methods or unrelated routes", () => {
  for (const path of [
    "/api/chats/:chatId/preparation-malformed",
    "/api/internal/native-history/new-export",
    "/api/internal/native-queue/new-command",
  ])
    assert.equal(nativeRouteContentClassification({ path }), undefined);
  assert.equal(
    nativeWorkerCommandContentClassification("chat.new-command"),
    undefined,
  );
});
