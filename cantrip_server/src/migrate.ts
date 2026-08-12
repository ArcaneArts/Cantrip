import { readServerConfig } from "./config.js";
import { connectDatabase } from "./db/index.js";

async function migrate(): Promise<void> {
  const config = readServerConfig();
  const database = await connectDatabase(config);
  try {
    await database.ping();
    console.log(
      JSON.stringify({
        database: database.engine,
        event: "database.migrations-complete",
      }),
    );
  } finally {
    await database.close();
  }
}

migrate().catch((error: unknown) => {
  console.error("Cantrip Server migrations failed", error);
  process.exitCode = 1;
});
