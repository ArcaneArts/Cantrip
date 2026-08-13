const databaseName = "cantrip-client-bootstrap";
const databaseVersion = 1;
const objectStoreName = "settings";
export const serverConnectionStorageKey = "cantrip.server-connections.v1";

export type ServerConnectionStorageAccess = {
  readBackup(): Promise<string | null>;
  readPrimary(): string | null;
  requestPersistence(): Promise<boolean>;
  writeBackup(value: string): Promise<void>;
  writePrimary(value: string): void;
};

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is unavailable."));
      return;
    }
    const request = indexedDB.open(databaseName, databaseVersion);
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error("Cantrip client storage is blocked."));
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(objectStoreName)) {
        request.result.createObjectStore(objectStoreName);
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

async function readIndexedDb(): Promise<string | null> {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(objectStoreName, "readonly");
      const request = transaction
        .objectStore(objectStoreName)
        .get(serverConnectionStorageKey);
      request.onerror = () => reject(request.error);
      request.onsuccess = () =>
        resolve(typeof request.result === "string" ? request.result : null);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

async function writeIndexedDb(value: string): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(objectStoreName, "readwrite");
      transaction
        .objectStore(objectStoreName)
        .put(value, serverConnectionStorageKey);
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
      transaction.oncomplete = () => resolve();
    });
  } finally {
    database.close();
  }
}

const browserStorageAccess: ServerConnectionStorageAccess = {
  readBackup: readIndexedDb,
  readPrimary: () => window.localStorage.getItem(serverConnectionStorageKey),
  requestPersistence: async () =>
    (await globalThis.navigator?.storage?.persist?.()) ?? false,
  writeBackup: writeIndexedDb,
  writePrimary: (value) =>
    window.localStorage.setItem(serverConnectionStorageKey, value),
};

export async function readServerConnectionPayloads(
  access: ServerConnectionStorageAccess = browserStorageAccess,
): Promise<string[]> {
  const payloads: string[] = [];
  try {
    const primary = access.readPrimary();
    if (primary !== null) payloads.push(primary);
  } catch {
    // A privacy mode may disable localStorage while IndexedDB still works.
  }
  try {
    const backup = await access.readBackup();
    if (backup !== null && !payloads.includes(backup)) payloads.push(backup);
  } catch {
    // Keep bootstrapping from localStorage when IndexedDB is unavailable.
  }
  return payloads;
}

export async function writeServerConnectionPayload(
  value: string,
  access: ServerConnectionStorageAccess = browserStorageAccess,
): Promise<void> {
  const persistenceRequest = Promise.resolve()
    .then(() => access.requestPersistence())
    .catch(() => false);
  const writes = await Promise.allSettled([
    Promise.resolve().then(() => access.writePrimary(value)),
    Promise.resolve().then(() => access.writeBackup(value)),
  ]);
  await persistenceRequest;
  if (writes.every((result) => result.status === "rejected")) {
    throw new Error(
      "This browser could not save the server profile. Check its site-storage settings and try again.",
    );
  }
}
