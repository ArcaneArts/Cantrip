import http from "node:http";
import net from "node:net";

const httpPort = Number.parseInt(
  process.env.CANTRIP_QA_HTTP_PORT ?? "4391",
  10,
);
const vncPort = Number.parseInt(process.env.CANTRIP_QA_VNC_PORT ?? "5909", 10);

if (!Number.isInteger(httpPort) || httpPort < 1 || httpPort > 65_535) {
  throw new Error("CANTRIP_QA_HTTP_PORT must be a valid TCP port.");
}
if (!Number.isInteger(vncPort) || vncPort < 1 || vncPort > 65_535) {
  throw new Error("CANTRIP_QA_VNC_PORT must be a valid TCP port.");
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

const vncSockets = new Set();

const httpServer = http.createServer((request, response) => {
  if (request.url === "/vnc/drop") {
    for (const socket of vncSockets) socket.destroy();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ dropped: true }));
    return;
  }
  if (request.url === "/vnc/status") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ connections: vncSockets.size }));
    return;
  }
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(fixturePage);
});

const width = 640;
const height = 360;

function writeUInt16(value) {
  const result = Buffer.allocUnsafe(2);
  result.writeUInt16BE(value);
  return result;
}

function renderFrame(pointerX = width / 2, pointerY = height / 2) {
  const pixels = Buffer.allocUnsafe(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const onPointer =
        Math.abs(x - pointerX) < 8 && Math.abs(y - pointerY) < 8;
      pixels[offset] = onPointer ? 255 : 40 + Math.floor((x / width) * 80);
      pixels[offset + 1] = onPointer
        ? 255
        : 35 + Math.floor((y / height) * 120);
      pixels[offset + 2] = onPointer ? 255 : 35 + Math.floor((x / width) * 55);
      pixels[offset + 3] = 0;
    }
  }

  const header = Buffer.alloc(16);
  header[0] = 0;
  header.writeUInt16BE(1, 2);
  header.writeUInt16BE(width, 8);
  header.writeUInt16BE(height, 10);
  header.writeInt32BE(0, 12);
  return Buffer.concat([header, pixels]);
}

function sendServerInit(socket) {
  const name = Buffer.from("Cantrip deterministic VNC fixture", "utf8");
  const pixelFormat = Buffer.from([
    32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0,
  ]);
  const nameLength = Buffer.allocUnsafe(4);
  nameLength.writeUInt32BE(name.length);
  socket.write(
    Buffer.concat([
      writeUInt16(width),
      writeUInt16(height),
      pixelFormat,
      nameLength,
      name,
    ]),
  );
  setTimeout(() => {
    if (!socket.destroyed) socket.write(renderFrame());
  }, 100);
}

function consumeClientMessages(state) {
  while (state.buffer.length > 0) {
    const type = state.buffer[0];
    let length;
    if (type === 0) length = 20;
    else if (type === 2) {
      if (state.buffer.length < 4) return;
      length = 4 + state.buffer.readUInt16BE(2) * 4;
    } else if (type === 3) length = 10;
    else if (type === 4) length = 8;
    else if (type === 5) length = 6;
    else if (type === 6) {
      if (state.buffer.length < 8) return;
      length = 8 + state.buffer.readUInt32BE(4);
    } else if (type === 150) length = 1;
    else if (type === 248) {
      if (state.buffer.length < 9) return;
      length = 9 + state.buffer[8];
    } else if (type === 251) {
      if (state.buffer.length < 8) return;
      length = 8 + state.buffer[6] * 4;
    } else {
      state.socket.destroy(new Error(`Unsupported RFB client message ${type}`));
      return;
    }

    if (state.buffer.length < length) return;
    const message = state.buffer.subarray(0, length);
    state.buffer = state.buffer.subarray(length);
    if (type === 3)
      state.socket.write(renderFrame(state.pointerX, state.pointerY));
    if (type === 5) {
      state.pointerX = message.readUInt16BE(2);
      state.pointerY = message.readUInt16BE(4);
      state.socket.write(renderFrame(state.pointerX, state.pointerY));
    }
  }
}

const vncServer = net.createServer((socket) => {
  vncSockets.add(socket);
  socket.setNoDelay(true);
  const state = {
    socket,
    phase: "version",
    buffer: Buffer.alloc(0),
    pointerX: width / 2,
    pointerY: height / 2,
  };
  socket.write("RFB 003.008\n");

  socket.on("data", (chunk) => {
    state.buffer = Buffer.concat([state.buffer, chunk]);
    while (true) {
      if (state.phase === "version") {
        if (state.buffer.length < 12) return;
        state.buffer = state.buffer.subarray(12);
        socket.write(Buffer.from([1, 1]));
        state.phase = "security";
      } else if (state.phase === "security") {
        if (state.buffer.length < 1) return;
        state.buffer = state.buffer.subarray(1);
        socket.write(Buffer.from([0, 0, 0, 0]));
        state.phase = "client-init";
      } else if (state.phase === "client-init") {
        if (state.buffer.length < 1) return;
        state.buffer = state.buffer.subarray(1);
        sendServerInit(socket);
        state.phase = "messages";
      } else {
        consumeClientMessages(state);
        return;
      }
    }
  });
  socket.on("error", () => undefined);
  socket.on("close", () => vncSockets.delete(socket));
});

await Promise.all([
  new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(httpPort, "127.0.0.1", resolve);
  }),
  new Promise((resolve, reject) => {
    vncServer.once("error", reject);
    vncServer.listen(vncPort, "127.0.0.1", resolve);
  }),
]);

console.log(`[cantrip_qa] Browser fixture: http://127.0.0.1:${httpPort}`);
console.log(`[cantrip_qa] VNC fixture: 127.0.0.1:${vncPort} (no password)`);
console.log(
  `[cantrip_qa] Drop VNC clients: http://127.0.0.1:${httpPort}/vnc/drop`,
);

async function shutdown() {
  for (const socket of vncSockets) socket.destroy();
  await Promise.all([
    new Promise((resolve) => httpServer.close(resolve)),
    new Promise((resolve) => vncServer.close(resolve)),
  ]);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void shutdown().finally(() => process.exit(0));
  });
}
