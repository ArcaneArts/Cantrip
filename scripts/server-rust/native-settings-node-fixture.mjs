import { createRequire } from "node:module";
const require = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
);
const { sql, eq } = require("drizzle-orm");
import * as schema from "../../cantrip_server/src/db/schema.ts";
import {
  NativeSettingsStateRepository,
  assertNativeSettingsWriteBinding,
  admitNativeSettingsState,
  settleNativeSettingsState,
  settleNativeSettingsTransport,
  changeNativeSettingsState,
} from "../../cantrip_server/src/db/repository/native-settings-persistence.ts";
import { lockNativeCommandChat } from "../../cantrip_server/src/db/repository/native-command-lock.ts";
import { scopedNativeModelAttribution } from "../../cantrip_server/src/db/repository/native-model-attribution.ts";
import { readNativeModelInventory } from "../../cantrip_server/src/models/native-model-inventory.ts";

export async function nativeSettingsFixture(repository, input) {
  const db = repository.nativeCommands.database;
  const settings = new NativeSettingsStateRepository(db);
  const { owner, chat } = input;
  if (input.op === "native-command-settings-model-inventory")
    return readNativeModelInventory(repository, owner, input.input);
  if (input.op === "native-command-settings-get")
    return settings.get(owner, chat);
  if (input.op === "native-command-settings-resolve")
    return settings.resolveWriteBinding(owner, chat, input.bindingId);
  if (input.op === "native-command-settings-observe")
    return settings.observe(owner, input.input);
  if (input.op === "native-command-settings-refresh") {
    const reads = [];
    const state = await settings.refresh(owner, chat, async (scope) => {
      reads.push(scope);
      if (input.readFailure) throw new Error(input.readFailure);
      for (const statement of input.afterReadSql ?? [])
        await db.execute(sql.raw(statement));
      if (input.publishDuringRead)
        await settings.refresh(
          owner,
          chat,
          async () => input.publishDuringRead,
        );
      return input.snapshot;
    });
    return { state, reads };
  }
  return db.transaction(async (tx) => {
    await lockNativeCommandChat(tx, owner, chat);
    if (input.op === "native-command-settings-assert-source")
      return assertNativeSettingsWriteBinding(
        tx,
        owner,
        chat,
        input.bindingId,
        input.source,
      );
    if (input.op === "native-command-settings-scope-model")
      return scopedNativeModelAttribution(
        tx,
        owner,
        input.scope,
        input.snapshot,
      );
    if (input.op === "native-command-settings-change")
      return changeNativeSettingsState(tx, chat, () => input.state);
    const [command] = await tx
      .select()
      .from(schema.nativeCommands)
      .where(eq(schema.nativeCommands.operationId, input.operation));
    if (input.op === "native-command-settings-admit")
      await admitNativeSettingsState(tx, command);
    else if (input.op === "native-command-settings-settle")
      await settleNativeSettingsState(tx, command, input.outcome);
    else if (input.op === "native-command-settings-transport")
      await settleNativeSettingsTransport(tx, command);
    else throw new Error("Unknown native settings operation: " + input.op);
    return null;
  });
}
