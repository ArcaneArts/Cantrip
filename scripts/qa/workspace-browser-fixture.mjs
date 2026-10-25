import http from "node:http";
import { pathToFileURL } from "node:url";

export async function startWorkspaceBrowserFixture() {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(`<!doctype html><html><head><title>Workspace browser QA</title>
<style>body{font:20px system-ui;background:#18202c;color:white;padding:24px}button,input{font:inherit}section{height:900px;border-bottom:1px solid #888}</style></head>
<body><h1>Workspace browser QA</h1><p>This page keeps state only in this browser document.</p>
<p>Document instance: <output id="instance"></output></p>
<label>Unsaved browser input <input id="draft"></label>
<button id="increment">Increment</button><output id="count">0</output>
<section>Top scroll marker</section><section>Middle scroll marker</section><p>Bottom scroll marker</p>
<script>document.querySelector('#instance').textContent=crypto.randomUUID();
document.querySelector('#increment').onclick=()=>{const count=document.querySelector('#count');count.textContent=String(Number(count.textContent)+1)};</script></body></html>`);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const fixture = await startWorkspaceBrowserFixture();
  console.log(
    `QA_EVT ${JSON.stringify({ event: "native.browser.fixture", status: "info", origin: fixture.origin })}`,
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => void fixture.close());
}
