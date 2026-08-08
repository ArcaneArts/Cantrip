import { buildApp } from "./app.js";
import { readServerConfig } from "./config.js";
import { connectDatabase } from "./db/index.js";

async function start(): Promise<void> {
  const config = readServerConfig();
  const database = await connectDatabase(config);
  const app = await buildApp({ config, database });
  let closing = false;

  if (config.allowInsecureRemote) {
    app.log.warn(
      "CANTRIP_ALLOW_INSECURE_REMOTE is enabled: application APIs do not authenticate users yet.",
    );
  }

  const close = async (signal: NodeJS.Signals) => {
    if (closing) {
      return;
    }

    closing = true;
    app.log.info({ signal }, "Shutting down Cantrip Server");
    await app.close();
  };

  process.once("SIGINT", () => void close("SIGINT"));
  process.once("SIGTERM", () => void close("SIGTERM"));

  await app.listen({ host: config.host, port: config.port });
  app.log.info({ database: database.engine }, "Cantrip Server is ready");
}

start().catch((error: unknown) => {
  console.error("Cantrip Server failed to start", error);
  process.exitCode = 1;
});
