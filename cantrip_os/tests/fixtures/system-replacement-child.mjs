import { appendFile, readFile, writeFile } from "node:fs/promises";
const config = JSON.parse(await readFile(process.argv[2], "utf8"));
const host = await import(config.hostModule);
const engine = await host.LocalDocker.current(),
  request = engine.request.bind(engine),
  loadImage = engine.loadImage.bind(engine);
engine.loadImage = async (source, options) => {
  await appendFile(
    config.trace,
    JSON.stringify({ method: "STREAM-LOAD", path: "/images/load" }) + "\n",
    { mode: 0o600 },
  );
  return loadImage(source, options);
};
engine.request = async (method, path, body, options) => {
  await appendFile(config.trace, JSON.stringify({ method, path }) + "\n", {
    mode: 0o600,
  });
  const receipt = await request(method, path, body, options);
  if (
    method === "POST" &&
    ((config.hold === "create" && path.startsWith("/containers/create?")) ||
      (config.hold === "start" &&
        path === `/containers/${config.holdId}/start`))
  ) {
    await writeFile(
      config.marker,
      JSON.stringify({ pid: process.pid, path, receipt }),
      { mode: 0o600 },
    );
    process.send?.({ held: config.hold });
    await new Promise(() => {
      setInterval(() => {}, 1000);
    });
  }
  return receipt;
};
try {
  const result = await host.replaceSystem(engine, config.input);
  process.send?.({ unexpectedResult: result?.operation });
  process.exitCode = 2;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
