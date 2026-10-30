// Disposable listener for the full-worker acceptance flow. It must answer on
// its own event loop while the browser/Vite test driver is busy.
import { createServer } from "node:http";

const title = process.argv[2];
if (!title) throw new Error("A discovery fixture title is required");
const publish = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const server = createServer((request, response) => {
  publish({
    event: "test.discovery.request",
    method: request.method,
    url: request.url,
    receivedAt: Date.now(),
  });
  response.once("finish", () =>
    publish({ event: "test.discovery.response", finishedAt: Date.now() }),
  );
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(
    "<!doctype html><title>" + title + "</title><p>Discovery fixture</p>",
  );
});
server.listen(0, "127.0.0.1", () =>
  publish({
    event: "server.listening",
    origin: "http://127.0.0.1:" + server.address().port,
  }),
);
process.stdin.resume();
process.stdin.once("end", () => {
  server.closeAllConnections();
  server.close();
});
