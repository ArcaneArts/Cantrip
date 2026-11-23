import { vi } from "vitest";
import type { CodexAppServer } from "../../src/codex/app-server.js";
import { NativeHistoryObservations } from "../../src/codex/native-history-observation.js";

/** Give fake RPC transports the same pre-reducer observation ordering as a connection. */
export function connectFixtureNativeObservation(
  runtime: CodexAppServer,
  generation = "fixture-transport",
) {
  const observations = new NativeHistoryObservations();
  observations.replace(generation);
  vi.spyOn(runtime, "transportGeneration", "get").mockReturnValue(generation);
  vi.spyOn(runtime, "observeNativeHistory").mockImplementation(
    (thread, observer) =>
      observations.subscribe(thread, observer, () =>
        runtime.readNativeHistory(thread),
      ),
  );
  const native = runtime as unknown as { handleMessage(data: Buffer): void };
  const handleMessage = native.handleMessage.bind(runtime);
  native.handleMessage = (data) => {
    const message = JSON.parse(data.toString());
    observations.notification(message.method, message.params);
    handleMessage(data);
  };
  return observations;
}
