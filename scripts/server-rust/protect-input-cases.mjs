import assert from "node:assert/strict";
import {
  retainedPrompt,
  deferredAttachment,
} from "./native-settlement-fixtures.mjs";
export async function runProtectInputCases({ observe }) {
  const response = retainedPrompt().pendingMessage;
  for (const fields of [
    { input: { text: "A private fixture input", idempotencyKey: "input-key" } },
    { input: { text: "", mode: null } },
    {
      input: {
        text: " raw-\ud800-\udfff ",
        mode: "plan",
        idempotencyKey: " raw-key ",
      },
      reasoningEffort: null,
    },
    {
      input: { text: "  ", mode: "goal" },
      reasoningEffort: " high ",
      role: "system",
    },
    {
      input: { text: "attached input" },
      attachments: [deferredAttachment("first"), deferredAttachment("second")],
    },
    { input: {}, attachments: [deferredAttachment("only")], role: "system" },
  ]) {
    const values = await observe(
      "worker input protection packet " + JSON.stringify(fields),
      { worker: "alpha", response, ...fields },
      { op: "native-command-gui-protect", shape: "raw" },
    );
    for (const value of values) {
      assert.equal(value.command.type, "chat.message.protect");
      assert.equal(value.worker, "alpha");
      assert.equal(value.result.id, response.id);
      const expected = [
        "id",
        "role",
        "mode",
        ...(Object.hasOwn(fields, "reasoningEffort")
          ? ["reasoningEffort"]
          : []),
        "content",
        ...(Object.hasOwn(fields.input, "idempotencyKey")
          ? ["idempotencyKey"]
          : []),
      ];
      assert.deepEqual(
        Object.keys(value.command.message),
        expected,
        "Preserve actual packet field order as well as values",
      );
      for (const item of value.command.message.content.filter(
        (v) => v.type === "attachment",
      )) {
        assert.equal(item.attachment.fileName, "Protected attachment");
        assert.equal(item.attachment.mimeType, "application/octet-stream");
        assert.deepEqual(Object.keys(item.attachment), [
          "id",
          "chatId",
          "fileName",
          "mimeType",
          "sizeBytes",
          "kind",
          "source",
          "status",
          "previewText",
          "createdAt",
        ]);
      }
    }
  }
  for (const invalid of [
    null,
    {},
    {
      ...response,
      classification: { ...response.classification, role: "unknown" },
    },
  ])
    await observe(
      "worker protection response validation " + JSON.stringify(invalid),
      { worker: "alpha", input: { text: "fixture" }, response: invalid },
      { op: "native-command-gui-protect", shape: "raw", error: true },
    );
  await observe(
    "worker protection failure propagates",
    {
      worker: "alpha",
      input: { text: "fixture" },
      response,
      failRequest: true,
    },
    { op: "native-command-gui-protect", shape: "raw", error: true },
  );
}
