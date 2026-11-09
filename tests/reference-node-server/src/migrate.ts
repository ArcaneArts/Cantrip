import { readServerConfig } from "./config.js";
import { connectDatabase } from "./db/index.js";
import { serverLogger } from "./logger.js";

async function migrate(): Promise<void> {
  const config = readServerConfig();
  const database = await connectDatabase(config);
  try {
    await database.ping();
    serverLogger.info("Database migrations complete", {
      database: database.engine,
    });
  } finally {
    await database.close();
  }
}

migrate().catch((error: unknown) => {
  serverLogger.error("Cantrip Server migrations failed", error);
  process.exitCode = 1;
});
