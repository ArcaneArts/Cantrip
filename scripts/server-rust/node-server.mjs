// Test oracle: the actual Node service, listening on an OS-assigned port.
import { buildApp } from "../../cantrip_server/src/app.ts";
import { readServerConfig } from "../../cantrip_server/src/config.ts";
import { connectDatabase } from "../../cantrip_server/src/db/index.ts";

const config = readServerConfig();
const database = await connectDatabase(config);
const diagnose = (event, details = {}) =>
  console.error(JSON.stringify({ event, ...details }));
const closeDatabase = database.close.bind(database);
database.close = async () => {
  diagnose("fixture.database.closing");
  await closeDatabase();
  diagnose("fixture.database.closed");
};
const app = await buildApp({ config, database, logger: false });
const sockets = new Set();
app.server.on("connection", (socket) => {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
});
app.server.once("close", () => diagnose("fixture.http.closed"));
app.addHook("preClose", async () => diagnose("fixture.pre-close"));
app.addHook("onClose", async () => diagnose("fixture.on-close.started"));
const origin = await app.listen({ host: "127.0.0.1", port: 0 });
console.log(JSON.stringify({ event: "server.listening", origin }));

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  const snapshot = (event) =>
    diagnose(event, {
      sockets: [...sockets].map((socket) => ({
        state: socket.readyState,
        destroyed: socket.destroyed,
        readable: socket.readable,
        writable: socket.writable,
      })),
      websocketStates: [...app.websocketServer.clients].map(
        (socket) => socket.readyState,
      ),
      resources: process.getActiveResourcesInfo(),
    });
  snapshot("fixture.shutdown.started");
  const timer = setInterval(() => snapshot("fixture.shutdown.pending"), 5000);
  timer.unref();
  try {
    await app.close();
    snapshot("fixture.shutdown.completed");
  } finally {
    clearInterval(timer);
  }
}
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
process.stdin.once("end", () => void stop());
process.stdin.resume();
