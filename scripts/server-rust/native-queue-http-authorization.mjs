import assert from "node:assert/strict";
import { rejectedEventCredentials } from "./native-event-http-setup.mjs";

export function nativeQueueInputs(read, admission, prompt) {
  return {
    lookup: { admission },
    read,
    mutate: {
      admission,
      expectedRevision: 0,
      mutation: { kind: "add", prompt, attachments: [] },
    },
    import: { ...read, runnerGeneration: "runner", items: [] },
    "import-ack": {
      ...read,
      runnerGeneration: "runner",
      importId: "missing",
      sourceDigest: "b".repeat(64),
      receipt: { deleted: true, conflict: false },
    },
    "start-receipt": { ...read, claimId: "missing" },
  };
}

export async function nativeQueueHttpAuthorization({
  call,
  read,
  admission,
  prompt,
}) {
  for (const [action, input] of Object.entries(
    nativeQueueInputs(read, admission, prompt),
  )) {
    const denied = async (name, value, headers) =>
      assert.deepEqual(
        await call(action + " " + name, action, value, {
          headers,
          status: 401,
        }),
        { code: "unauthorized" },
      );
    await denied("requires a worker credential", input, {});
    for (const credential of rejectedEventCredentials)
      await denied("rejects " + credential.reason + " credential", input, {
        authorization: "Bearer " + credential.credential,
      });
    const other = input.admission
      ? {
          ...input,
          admission: {
            ...input.admission,
            workerId: "another-native-queue-worker",
          },
        }
      : { ...input, workerId: "another-native-queue-worker" };
    // The real credential remains in call's default headers.
    assert.deepEqual(
      await call(
        action + " rejects credential worker mismatch",
        action,
        other,
        { status: 401 },
      ),
      { code: "unauthorized" },
    );
    assert.deepEqual(
      await call(
        action + " rejects body owner override",
        action,
        { ...input, ownerId: "spoofed-owner" },
        { status: 400 },
      ),
      { code: "invalid-queue-request" },
    );
    assert.deepEqual(
      await call(action + " binary JSON remains a Buffer", action, undefined, {
        raw: Buffer.from(JSON.stringify(input)),
        headers: { "content-type": "application/octet-stream" },
        status: 400,
      }),
      { code: "invalid-queue-request" },
    );
  }
}
