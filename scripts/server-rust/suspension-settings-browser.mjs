import assert from "node:assert/strict";

/** Use the same bound, encrypted native-settings operation as the composer. */
export async function updatePausedSuspensionSettings(page, chatId, effort) {
  const result = await page.evaluate(
    async ({ chatId, effort }) => {
      const { getClientSessionIdentitySnapshot } =
        await import("/src/lib/client-session.ts");
      const { readNativeSettingsState } =
        await import("/src/lib/native-settings-api.ts");
      const { prepareNativeSettingsUpdate, sendNativeSettingsUpdate } =
        await import("/src/lib/native-settings-update.ts");
      const identity = getClientSessionIdentitySnapshot();
      const state = await readNativeSettingsState({
        chatId,
        identity,
        refresh: true,
      });
      const operationId = crypto.randomUUID();
      const request = await prepareNativeSettingsUpdate({
        chatId,
        binding: state.binding,
        patch: { effort },
        operationId,
      });
      const receipt = await sendNativeSettingsUpdate({
        chatId,
        identity,
        request,
      });
      return { effort, operationId, receipt, threadId: state.binding.threadId };
    },
    { chatId, effort },
  );
  assert.equal(result.receipt.operationId, result.operationId);
  assert.ok(
    ["queued", "applied"].includes(result.receipt.status),
    JSON.stringify(result),
  );
  return result;
}

export async function readSuspensionSettings(page, chatId, refresh = true) {
  return page.evaluate(
    async ({ chatId, refresh }) => {
      const identity = (
        await import("/src/lib/client-session.ts")
      ).getClientSessionIdentitySnapshot();
      const state = await (
        await import("/src/lib/native-settings-api.ts")
      ).readNativeSettingsState({ chatId, identity, refresh });
      const settings = await (
        await import("/src/lib/native-settings-encryption.ts")
      ).openNativeSettingsState({ chatId, state });
      return settings
        ? {
            effort: settings.effort,
            model: settings.model,
            settingsVersion: settings.settingsVersion,
            refreshed: refresh,
          }
        : null;
    },
    { chatId, refresh },
  );
}
