import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { LOCAL_USER_ID } from "../src/db/repository.js";
import * as schema from "../src/db/schema.js";
import {
  createNativeSettingsFixture,
  settingsEnvelope,
} from "./native-settings-repository-fixture.js";
import type { NativeModelAttribution } from "@cantrip/protocol";
let fixture: Awaited<ReturnType<typeof createNativeSettingsFixture>>;
let selected: Extract<NativeModelAttribution, { status: "resolved" }>;
let anchorRoute: string;
let revision = 0;
beforeAll(async () => {
  fixture = await createNativeSettingsFixture();
  const [model] = await fixture.repository.getModelRuntimes(LOCAL_USER_ID);
  anchorRoute = model!.routeId;
  const context = (await fixture.repository.getChatExecutionContext(
    LOCAL_USER_ID,
    fixture.chatId,
  ))!;
  await fixture.repository.updateChatRuntime(
    fixture.chatId,
    fixture.workerId,
    context.worktreeId!,
    context.threadId!,
    anchorRoute,
    "ready",
    null,
  );
  await fixture.db.insert(schema.modelRoutes).values({
    id: "selected-native-route",
    modelId: model!.model.id,
    providerId: model!.provider.id,
    modelName: "selected-native",
    position: 99,
  });
  selected = {
    status: "resolved",
    workerId: fixture.workerId,
    providerId: model!.provider.id,
    providerAccountId: null,
    modelId: model!.model.id,
    routeId: "selected-native-route",
  };
}, 60000);
afterAll(async () => {
  await fixture?.close();
});
const refresh = (selection: NativeModelAttribution) =>
  fixture.commands.refreshSettingsState(
    LOCAL_USER_ID,
    fixture.chatId,
    async (scope) => ({
      context: {
        chatId: scope.chatId,
        workerId: scope.workerId,
        threadId: scope.threadId,
        runtimeGeneration: "runtime-one",
        settingsVersion: { epoch: "core", revision: String(++revision) },
      },
      contentFingerprint: "a".repeat(64),
      protectedContent: settingsEnvelope,
      modelAttribution: { selection, fingerprint: "b".repeat(64) },
    }),
  );
describe("canonical native model attribution", () => {
  it("persists a separate selected route without moving the physical session, and survives restart", async () => {
    const state = await refresh(selected);
    expect(state.effective!.modelAttribution!.selection).toEqual(selected);
    expect(state.binding!.modelRouteId).toBe(anchorRoute);
    expect(state.pending).toEqual([]);
    const context = (await fixture.repository.getChatExecutionContext(
      LOCAL_USER_ID,
      fixture.chatId,
    ))!;
    expect(context.modelRouteId).toBe(anchorRoute);
    await fixture.restart();
    expect(
      await fixture.commands.settingsState(LOCAL_USER_ID, fixture.chatId),
    ).toEqual(state);
  });
  it.each([
    "workerId",
    "providerId",
    "providerAccountId",
    "modelId",
    "routeId",
  ] as const)(
    "discards a mismatched %s claim but preserves the actual native snapshot",
    async (field) => {
      const state = await refresh({ ...selected, [field]: "wrong" });
      expect(state.effective!.modelAttribution).toBeUndefined();
      expect(state.effective!.protectedContent).toEqual(settingsEnvelope);
      expect(state.binding!.modelRouteId).toBe(anchorRoute);
    },
  );
  it("does not gate a native observation on a route deleted since inventory was read", async () => {
    await fixture.db
      .delete(schema.modelRoutes)
      .where(eq(schema.modelRoutes.id, selected.routeId));
    const state = await refresh(selected);
    expect(state.effective!.modelAttribution).toBeUndefined();
    expect(state.effective!.context.settingsVersion.revision).toBe(
      String(revision),
    );
  });
});
