import {
  serverBootstrapSchema,
  systemHealthSchema,
  workerListSchema,
} from "@cantrip/protocol";

const serverUrl = (import.meta.env.VITE_CANTRIP_SERVER_URL ?? "").replace(
  /\/$/,
  "",
);

async function get(path: string): Promise<unknown> {
  const response = await fetch(`${serverUrl}${path}`, {
    credentials: "include",
    headers: { accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`Cantrip Server returned HTTP ${response.status}.`);
  }

  return response.json();
}

export async function getSystemHealth() {
  return systemHealthSchema.parse(await get("/api/health"));
}

export async function getServerBootstrap() {
  return serverBootstrapSchema.parse(await get("/api/bootstrap"));
}

export async function getWorkers() {
  return workerListSchema.parse(await get("/api/workers"));
}
