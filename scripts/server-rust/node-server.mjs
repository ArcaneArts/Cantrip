// Test oracle: the actual Node service, listening on an OS-assigned port.
import { buildApp } from "../../cantrip_server/src/app.ts";
import { readServerConfig } from "../../cantrip_server/src/config.ts";
import { connectDatabase } from "../../cantrip_server/src/db/index.ts";

const config = readServerConfig();
const database = await connectDatabase(config);
const app = await buildApp({ config, database, logger: false });
const origin = await app.listen({ host: "127.0.0.1", port: 0 });
console.log(JSON.stringify({ event: "server.listening", origin }));

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await app.close();
}
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
process.stdin.once("end", () => void stop());
process.stdin.resume();
