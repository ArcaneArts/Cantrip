import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

interface StoredWorkerCredential {
  credential: string;
  serverUrl: string;
  version: 1;
  workerId: string;
}

function readJson(pathname: string): unknown {
  try {
    return JSON.parse(readFileSync(pathname, "utf8"));
  } catch {
    return null;
  }
}

export function loadStoredWorkerCredential(
  dataDirectory: string,
  serverUrl: string,
): StoredWorkerCredential | null {
  const pathname = path.join(dataDirectory, "worker-credential.json");
  if (!existsSync(pathname)) return null;
  const parsed = readJson(pathname) as Partial<StoredWorkerCredential> | null;
  if (
    parsed?.version !== 1 ||
    parsed.serverUrl !== serverUrl ||
    typeof parsed.workerId !== "string" ||
    !parsed.workerId ||
    typeof parsed.credential !== "string" ||
    !/^ctwk_[A-Za-z0-9_-]{43}$/u.test(parsed.credential)
  ) {
    throw new Error(
      "The stored worker credential is invalid or belongs to another server. Remove worker-credential.json or use the matching CANTRIP_WORKER_DATA_DIR.",
    );
  }
  chmodSync(pathname, 0o600);
  return parsed as StoredWorkerCredential;
}

export function loadOrCreateWorkerIdentity(dataDirectory: string): string {
  mkdirSync(dataDirectory, { recursive: true });
  const pathname = path.join(dataDirectory, "worker-identity.json");
  const parsed = existsSync(pathname)
    ? (readJson(pathname) as { version?: unknown; workerId?: unknown } | null)
    : null;
  if (
    parsed?.version === 1 &&
    typeof parsed.workerId === "string" &&
    parsed.workerId.length > 0
  ) {
    chmodSync(pathname, 0o600);
    return parsed.workerId;
  }
  if (parsed) {
    throw new Error("The stored worker identity is invalid.");
  }
  const workerId = `worker-${randomUUID()}`;
  writeFileSync(
    pathname,
    `${JSON.stringify({ version: 1, workerId }, null, 2)}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  return workerId;
}

export function saveWorkerCredential(input: {
  credential: string;
  dataDirectory: string;
  serverUrl: string;
  workerId: string;
}): void {
  mkdirSync(input.dataDirectory, { recursive: true });
  const pathname = path.join(input.dataDirectory, "worker-credential.json");
  const temporary = `${pathname}.${process.pid}.tmp`;
  writeFileSync(
    temporary,
    `${JSON.stringify(
      {
        version: 1,
        serverUrl: input.serverUrl,
        workerId: input.workerId,
        credential: input.credential,
      } satisfies StoredWorkerCredential,
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  renameSync(temporary, pathname);
  chmodSync(pathname, 0o600);
}
