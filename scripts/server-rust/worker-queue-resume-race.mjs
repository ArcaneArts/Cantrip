// Delay one real worker queue start so the browser-side peer can claim first.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const file = process.env.CANTRIP_TEST_QUEUE_RESUME_RACE;
if (
  file &&
  process.argv[1] === process.env.CANTRIP_TEST_QUEUE_RESUME_RACE_WORKER_ENTRY
) {
  const fetch = globalThis.fetch;
  let held = false;
  const report = (phase, value) => {
    const destination = file + "." + phase;
    writeFileSync(destination + ".tmp", JSON.stringify(value));
    renameSync(destination + ".tmp", destination);
  };
  globalThis.fetch = async (input, options) => {
    if (
      !held &&
      input instanceof URL &&
      input.pathname === "/api/internal/native-queue/mutate" &&
      existsSync(file + ".armed")
    ) {
      const { admission, mutation, expectedRevision } = JSON.parse(
        options.body,
      );
      if (
        mutation.kind === "start" &&
        admission.operationId.startsWith("queue-resume:") &&
        admission.session.chatId === readFileSync(file + ".armed", "utf8")
      ) {
        held = true;
        report("held", {
          operationId: admission.operationId,
          id: mutation.id,
          expectedRevision,
        });
        const deadline = Date.now() + 25_000;
        while (!existsSync(file + ".release")) {
          if (Date.now() >= deadline)
            throw new Error("Timed out waiting for the browser queue claim");
          await delay(25, undefined, { signal: options.signal });
        }
        const response = await fetch(input, options);
        const result = await response.clone().json();
        report("receipt", {
          httpStatus: response.status,
          operationId: result.receipt?.operationId,
          status: result.receipt?.status,
          rejectionCode: result.receipt?.rejectionCode,
          hasClaim: Boolean(result.claim),
        });
        return response;
      }
    }
    return fetch(input, options);
  };
}
