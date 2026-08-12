import { randomBytes, randomUUID } from "node:crypto";

import {
  workerCredentialScopes,
  type WorkerCredentialScope,
} from "@cantrip/protocol";
import type { FastifyRequest } from "fastify";

import { hashSecret, safeSecretMatch } from "../auth/service.js";
import type { ServerConfig } from "../config.js";
import {
  LOCAL_USER_ID,
  type ActiveWorkerCredential,
  type ServerRepository,
} from "../db/repository.js";

export const DEFAULT_WORKER_CREDENTIAL_SCOPES = [
  ...workerCredentialScopes,
] as WorkerCredentialScope[];

export interface WorkerAuthentication extends ActiveWorkerCredential {
  development: boolean;
}

export function createWorkerEnrollmentCode(): {
  code: string;
  codeHash: string;
} {
  const code = `ctwl_${randomBytes(24).toString("base64url")}`;
  return { code, codeHash: hashSecret(code) };
}

export function createWorkerCredential(): {
  credential: string;
  credentialHash: string;
  credentialId: string;
} {
  const credential = `ctwk_${randomBytes(32).toString("base64url")}`;
  return {
    credential,
    credentialHash: hashSecret(credential),
    credentialId: randomUUID(),
  };
}

export function developmentWorkerBootstrapAllowed(
  config: ServerConfig,
): boolean {
  return (
    config.deploymentMode === "local" &&
    config.authMode === "none" &&
    ["127.0.0.1", "localhost", "::1"].includes(config.host) &&
    ["pnpm-dev", "tauri"].includes(config.bootstrapMode)
  );
}

function bearerCredential(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  const credential = header.slice(7);
  return credential.length > 0 && credential.length <= 512 ? credential : null;
}

export async function authenticateWorkerRequest(
  repository: ServerRepository,
  config: ServerConfig,
  request: FastifyRequest,
  workerId: string,
  requiredScope: WorkerCredentialScope,
): Promise<WorkerAuthentication | null> {
  const credential = bearerCredential(request);
  if (!credential) return null;
  if (
    developmentWorkerBootstrapAllowed(config) &&
    safeSecretMatch(credential, config.workerToken)
  ) {
    return {
      id: "development-bootstrap",
      ownerId: LOCAL_USER_ID,
      scopes: DEFAULT_WORKER_CREDENTIAL_SCOPES,
      workerId,
      development: true,
    };
  }
  if (!workerId) return null;
  const active = await repository.authenticateWorkerCredential(
    hashSecret(credential),
    workerId,
    requiredScope,
  );
  return active ? { ...active, development: false } : null;
}
