// Acceptance-only control for the disposable app compiled by the editor fixture.
// Production bundles never include this Vite plugin or its loopback controller.
import http from "node:http";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

export async function nativeDesktopBridge() {
  const token = randomUUID();
  const queues = new Map();
  const pending = new Map();
  let sequence = 0;
  let clientOrigin;
  const server = http.createServer(async (request, response) => {
    const headers = {
      "content-type": "application/json",
      "access-control-allow-origin": clientOrigin,
      "access-control-allow-headers": "authorization, content-type",
      "access-control-allow-methods": "POST, OPTIONS",
    };
    if (request.headers.origin !== clientOrigin) {
      response.writeHead(403);
      response.end();
      return;
    }
    if (request.method === "OPTIONS") {
      response.writeHead(204, headers);
      response.end();
      return;
    }
    if (request.headers.authorization !== "Bearer " + token) {
      response.writeHead(403, headers);
      response.end("{}");
      return;
    }
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks).toString());
      let result;
      if (request.url === "/poll") {
        result = queues.get(input.label)?.shift() ?? null;
      } else if (request.url === "/result") {
        const waiter = pending.get(input.id);
        if (waiter) {
          pending.delete(input.id);
          clearTimeout(waiter.timer);
          waiter.resolve(input);
        }
        result = {};
      } else throw new Error("Unknown native acceptance route");
      response.writeHead(200, headers);
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(500, headers);
      response.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port;
  const plugin = {
    name: "cantrip-isolated-native-acceptance",
    enforce: "pre",
    transform(source, id) {
      if (!id.replaceAll("\\", "/").endsWith("/cantrip_app/src/main.tsx"))
        return null;
      return {
        code: `${source}
import { isTauri as qaNative } from '@tauri-apps/api/core';
import { getCurrentWindow as qaCurrentWindow } from '@tauri-apps/api/window';
import { getAllWebviewWindows as qaWindows } from '@tauri-apps/api/webviewWindow';
import { getClientSessionIdentitySnapshot as rustQaIdentity } from '@/lib/client-session';
import { readWorkspaceDeviceIdentity as rustQaDevice } from '@/lib/workspace-device-identity';
import { workspaceLayoutTransport as rustQaTransport } from '@/lib/api/workspace-layouts';
if (qaNative()) {
  globalThis.__qaNativeWindows = qaWindows;
  globalThis.__qaNativeContext = crypto.randomUUID();
  globalThis.__qaNativeWorkspace = async projectId => {
    const identity = rustQaIdentity();
    const scope = await rustQaDevice(identity, projectId);
    return rustQaTransport(projectId, scope.workspaceId, identity).read();
  };
  const label = qaCurrentWindow().label;
  const post = async (route, body) => {
    const response = await fetch(${JSON.stringify(origin)} + route, {
      method: 'POST', headers: {'content-type':'application/json', authorization:${JSON.stringify("Bearer " + token)}}, body:JSON.stringify(body),
    });
    if (!response.ok) throw new Error('Native acceptance HTTP ' + response.status);
    return response.json();
  };
  const poll = async () => {
    try {
      const command = await post('/poll', {label});
      if (command) {
        let result;
        try { result={id:command.id,ok:true,value:await new Function(command.expression)()}; }
        catch(error) { result={id:command.id,ok:false,error:String(error.message),stack:String(error.stack)}; }
        await post('/result', result);
      }
    } catch(error) { console.warn('Native acceptance driver', String(error)); }
    setTimeout(poll, 100);
  };
  void poll();
}
`,
        map: null,
      };
    },
  };
  async function evaluate(label, fn, ...args) {
    const id = ++sequence;
    // Each serialized action can access this DOM lookup. It deliberately
    // excludes inactive editor nodes retained by the production content host.
    const expression = `const editor=name=>[...document.querySelectorAll('textarea')].find(n=>n.getAttribute('aria-label')==='Edit '+name&&n.getClientRects().length); return (async()=>(${fn.toString()})(...${JSON.stringify(args)}))();`;
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Native evaluation timed out in " + label));
      }, 45_000);
      pending.set(id, { resolve, reject, timer });
      const queue = queues.get(label) ?? [];
      queue.push({ id, expression });
      queues.set(label, queue);
    });
    if (!result.ok) throw new Error(result.error + "\n" + result.stack);
    return result.value;
  }
  async function until(label, fn, ...args) {
    const end = Date.now() + 45_000;
    for (;;) {
      const result = await evaluate(label, fn, ...args);
      if (result) return result;
      if (Date.now() > end)
        throw new Error("Native UI observation timed out: " + fn.toString());
      await delay(100);
    }
  }
  return {
    plugin,
    evaluate,
    until,
    setClientOrigin(value) {
      clientOrigin = value;
    },
    async close() {
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("Native acceptance controller closed"));
      }
      pending.clear();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
