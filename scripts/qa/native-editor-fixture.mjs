import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const appRequire = createRequire(path.join(root, "cantrip_app/package.json"));
const { createServer } = await import(appRequire.resolve("vite"));
export const fileVersion = (text) =>
  createHash("sha256").update(text).digest("hex");

/** Disposable actual filesystem fixture; no project files or account data. */
export async function startNativeEditorFixture(extraFiles = {}) {
  const directory = await mkdtemp(
    path.join(tmpdir(), "cantrip-native-editor-qa-"),
  );
  const files = new Set([
    "main.tsx",
    "other.py",
    "large.ts",
    ...Object.keys(extraFiles),
  ]);
  for (const [name, content] of Object.entries(extraFiles))
    await writeFile(path.join(directory, name), content);
  await writeFile(
    path.join(directory, "main.tsx"),
    'const message = "Hello Cantrip";\nexport function Card() {\n  return <div title={message}>😀 hello</div>;\n}\n',
  );
  await writeFile(
    path.join(directory, "other.py"),
    'def greet(name):\n    return f"Hello {name}"\n',
  );
  await writeFile(
    path.join(directory, "large.ts"),
    Array.from(
      { length: 20000 },
      (_, index) =>
        `const value${index} = ${index}; // ${"long ".repeat(index === 100 ? 2000 : 1)}`,
    ).join("\n") + "\n",
  );
  const requests = [];
  let saveDelay = 0;
  let failReads = false;
  const server = await createServer({
    root: path.join(root, "cantrip_app"),
    server: { port: 0, strictPort: false, host: "127.0.0.1" },
    plugins: [
      {
        name: "native-editor-qa-files",
        configureServer(vite) {
          vite.middlewares.use("/__qa/files/", (request, response) => {
            void (async () => {
              const name = decodeURIComponent(
                (request.url ?? "").split("?")[0],
              ).replace(/^\/+/, "");
              if (!files.has(name)) {
                response.writeHead(404).end();
                return;
              }
              requests.push({ method: request.method, name });
              const file = path.join(directory, name);
              const content = await readFile(file, "utf8");
              response.setHeader("content-type", "application/json");
              if (request.method === "GET") {
                if (failReads) response.writeHead(503).end("{}");
                else
                  response.end(
                    JSON.stringify({ content, version: fileVersion(content) }),
                  );
              } else if (request.method === "PUT") {
                let raw = "";
                for await (const chunk of request) raw += chunk;
                const input = JSON.parse(raw);
                if (saveDelay)
                  await new Promise((resolve) =>
                    setTimeout(resolve, saveDelay),
                  );
                // Compare at the actual write, including changes during delayed saves.
                if (
                  fileVersion(await readFile(file, "utf8")) !== input.version
                ) {
                  response.writeHead(409).end("{}");
                  return;
                }
                await writeFile(file, input.content);
                response.end(
                  JSON.stringify({ version: fileVersion(input.content) }),
                );
              } else response.writeHead(405).end();
            })().catch(() => {
              response.writeHead(500).end("{}");
            });
          });
        },
      },
    ],
  });
  try {
    await server.listen();
  } catch (error) {
    await server.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    directory,
    requests,
    url: `${server.resolvedUrls.local[0]}qa/native-editor.html`,
    delaySaves(ms) {
      saveDelay = ms;
    },
    failReads(value) {
      failReads = value;
    },
    async close() {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
