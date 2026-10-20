import type { ServerConfig } from "../config.js";
import type { ServerRepository } from "../db/repository.js";
import {
  hashPassword,
  normalizeAccountEmail,
  verifyPassword,
} from "./service.js";

/** Provision before accepting requests; only an Argon2id hash reaches storage. */
export async function ensureConfiguredAdministrator(
  config: ServerConfig,
  repository: Pick<ServerRepository, "accounts" | "ensureAccountConfiguration">,
): Promise<void> {
  if (config.authMode !== "accounts" || !config.adminPassword) return;
  if (!config.adminEmail) {
    throw new Error("CANTRIP_ADMIN_PASSWORD requires CANTRIP_ADMIN_EMAIL.");
  }
  const password = config.adminPassword;
  const user = await repository.accounts.ensureConfiguredAdministrator({
    email: config.adminEmail.trim(),
    normalizedEmail: normalizeAccountEmail(config.adminEmail),
    passwordHash: await hashPassword(password),
    passwordMatches: (encoded) => verifyPassword(encoded, password),
  });
  await repository.ensureAccountConfiguration(user.id);
}
