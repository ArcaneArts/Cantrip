/// <reference lib="webworker" />
import { FindIndex, type FindRequest } from "./index";
const worker = self as unknown as DedicatedWorkerGlobalScope;
let current: FindIndex | null = null,
  requestId = -1;
worker.onmessage = (event: MessageEvent<FindRequest>) => {
  const message = event.data;
  try {
    if (message.type === "search") {
      current = new FindIndex(message.text, message.query, message.anchor);
      requestId = message.requestId;
    } else if (message.requestId !== requestId || !current) return;
    else current.move(message.direction);
    worker.postMessage({ ...current.result(requestId), action: message.type });
  } catch {
    // Documents and queries are private endpoint data, never diagnostic output.
    worker.postMessage({ requestId: message.requestId, error: true });
  }
};
