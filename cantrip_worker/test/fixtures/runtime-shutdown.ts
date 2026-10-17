import { createInterface } from "node:readline";
import { CodeGraphRuntimeManager } from "../../src/codegraph/runtime.js";
import { PlaywrightRuntimeManager } from "../../src/managed-runtimes/playwright.js";
import { SearxngRuntimeManager } from "../../src/managed-runtimes/searxng.js";

const [component, dataDirectory, peer] = process.argv.slice(2);
if (!dataDirectory || !peer) throw new Error("Missing owned runtime fixture");
// Only the transport destination is controlled. Production timeouts, abort
// signals, response consumption, and lifecycle ownership remain in use.
const controlledFetch: typeof fetch = async (_input, options) => {
  const response = await fetch(peer, options);
  return new Response(response.body, {
    status: response.status,
    headers: response.headers,
  });
};
const manager =
  component === "codegraph"
    ? new CodeGraphRuntimeManager({ dataDirectory, fetch: controlledFetch })
    : component === "searxng"
      ? new SearxngRuntimeManager({ dataDirectory, fetch: controlledFetch })
      : new PlaywrightRuntimeManager({ dataDirectory, fetch: controlledFetch });
const preparing = manager.prepare();
void preparing.catch((error: unknown) => console.error(error));
const input = createInterface({ input: process.stdin, terminal: false });
input.once("line", async () => {
  await manager.close();
  await preparing;
  console.log("RUNTIME_CLOSED");
  input.close();
});
