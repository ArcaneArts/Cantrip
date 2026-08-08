import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const SECRET_REF =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class VncSecretStore {
  readonly #directory: string;

  constructor(dataDirectory: string) {
    this.#directory = path.join(dataDirectory, "vnc-secrets");
  }

  async set(_surfaceId: string, password: string): Promise<string> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const secretRef = randomUUID();
    await writeFile(this.pathFor(secretRef), password, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return secretRef;
  }

  async read(secretRef: string): Promise<string> {
    return readFile(this.pathFor(secretRef), "utf8");
  }

  async delete(secretRef: string): Promise<void> {
    await rm(this.pathFor(secretRef), { force: true });
  }

  private pathFor(secretRef: string): string {
    if (!SECRET_REF.test(secretRef)) {
      throw new Error("Invalid VNC secret reference.");
    }
    return path.join(this.#directory, `${secretRef}.secret`);
  }
}
