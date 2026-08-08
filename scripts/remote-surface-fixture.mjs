import http from "node:http";

const httpPort = Number.parseInt(
  process.env.CANTRIP_QA_HTTP_PORT ?? "4391",
  10,
);

if (!Number.isInteger(httpPort) || httpPort < 1 || httpPort > 65_535) {
  throw new Error("CANTRIP_QA_HTTP_PORT must be a valid TCP port.");
}

const fixturePage = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Cantrip Remote Surface QA</title>
    <style>
      :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, sans-serif; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: linear-gradient(135deg, #071320, #16253d); color: #f7fbff; }
      main { width: min(620px, calc(100vw - 48px)); padding: 36px; border: 1px solid #476487; border-radius: 24px; background: #0c1827e8; box-shadow: 0 24px 80px #0008; }
      h1 { margin: 0 0 8px; font-size: clamp(28px, 5vw, 48px); }
      p { color: #a9bdd5; line-height: 1.6; }
      .row { display: flex; gap: 12px; margin-top: 24px; }
      button, input { border: 1px solid #4f729c; border-radius: 10px; background: #132945; color: inherit; padding: 12px 16px; font: inherit; }
      button { cursor: pointer; }
      input { flex: 1; min-width: 0; }
      output { display: block; margin-top: 20px; color: #6ee7b7; }
    </style>
  </head>
  <body>
    <main>
      <div>Worker-streamed Chromium fixture</div>
      <h1>Remote Surface Ready</h1>
      <p>This deterministic page verifies navigation, rendering, keyboard input, pointer input, resize, reconnection, and pop-out behavior.</p>
      <div class="row">
        <input id="message" aria-label="Fixture message" placeholder="Type through the remote browser" />
        <button id="action">Activate</button>
      </div>
      <output id="result">Waiting for interaction.</output>
    </main>
    <script>
      let activations = 0;
      const message = document.querySelector('#message');
      const result = document.querySelector('#result');
      document.querySelector('#action').addEventListener('click', () => {
        activations += 1;
        result.textContent = 'Activated ' + activations + ' time(s): ' + (message.value || 'no message');
        document.title = 'Activated ' + activations + ' · Cantrip QA';
      });
    </script>
  </body>
</html>`;

const server = http.createServer((_request, response) => {
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-type": "text/html; charset=utf-8",
  });
  response.end(fixturePage);
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(httpPort, "127.0.0.1", resolve);
});

console.log(`[cantrip_qa] Browser fixture: http://127.0.0.1:${httpPort}`);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
  });
}
