import {
  encryptionKeyGrantCreateSchema,
  encryptionKeyGrantListSchema,
  encryptionKeyGrantSchema,
  encryptionPrincipalApprovalSchema,
  encryptionPrincipalListSchema,
  encryptionPrincipalSchema,
  workerEncryptionRefreshResultSchema,
  type EncryptionPrincipal,
  type WorkerEncryptionComponentScope,
} from "@cantrip/protocol/encryption";
import type { CuaPreviewLease } from "@cantrip/protocol/computer-use-preview";

import { request } from "./api-client";
import type { ClientSessionIdentitySnapshot } from "./client-session";
import {
  authorizeWorkerEncryption,
  type WorkerGrantApi,
  type WorkerGrantEncryptionService,
} from "./worker-encryption-grants";

/** Prepare only the protected control, approval, and history paths this lease uses. */
export async function prepareComputerUseWorkerEncryption(input: {
  baseUrl: string;
  identity: ClientSessionIdentitySnapshot;
  lease: CuaPreviewLease;
  service: WorkerGrantEncryptionService;
  keyRevision: number;
  signal: AbortSignal;
  assertCurrent: () => void;
  request?: typeof request;
}): Promise<void> {
  const components: WorkerEncryptionComponentScope[] = [
    "client-control-content",
    "interaction-content",
    input.lease.contentDomain === "task" ? "task-content" : "chat-content",
  ];
  const check = () => {
    input.assertCurrent();
    input.signal.throwIfAborted();
  };
  const send = async (path: string, body?: unknown): Promise<unknown> => {
    check();
    try {
      return await (input.request ?? request)(
        `${input.baseUrl.replace(/\/$/u, "")}${path}`,
        {
          method: body === undefined ? "GET" : "POST",
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: input.signal,
        },
        { expectedIdentity: input.identity, allowCsrfRecovery: false },
      );
    } finally {
      check();
    }
  };
  const principalPath = (id: string) =>
    `/api/encryption/principals/${encodeURIComponent(id)}`;
  const matchesPrincipal = (principal: EncryptionPrincipal) =>
    principal.ownerId === input.identity.userId &&
    principal.kind === "worker" &&
    principal.workerId === input.lease.workerId;
  const validatePrincipal = (value: unknown, id: string) => {
    const principal = encryptionPrincipalSchema.parse(value);
    if (principal.id !== id || !matchesPrincipal(principal))
      throw new Error("The worker encryption principal changed.");
    return principal;
  };
  const validateGrant = (value: unknown, id: string) => {
    const grant = encryptionKeyGrantSchema.parse(value);
    if (
      grant.ownerId !== input.identity.userId ||
      grant.principalId !== id ||
      grant.wrappedKey.purpose !== "worker-component-key" ||
      grant.wrappedKey.workerId !== input.lease.workerId
    )
      throw new Error(
        "The worker encryption grant belongs to another principal.",
      );
    return grant;
  };
  // This API instance is operation-owned: another preview cannot inherit its
  // cancellation signal through the grant author's in-flight deduplication.
  const api: WorkerGrantApi = {
    listPrincipals: async () =>
      encryptionPrincipalListSchema
        .parse(await send("/api/encryption/principals"))
        .filter(matchesPrincipal),
    approvePrincipal: async (id, expectedRevision) =>
      validatePrincipal(
        await send(
          `${principalPath(id)}/approve`,
          encryptionPrincipalApprovalSchema.parse({ expectedRevision }),
        ),
        id,
      ),
    listGrants: async (id) =>
      encryptionKeyGrantListSchema
        .parse(await send(`${principalPath(id)}/grants`))
        .map((grant) => validateGrant(grant, id)),
    createGrant: async (id, value) => {
      const grant = validateGrant(
        await send(
          `${principalPath(id)}/grants`,
          encryptionKeyGrantCreateSchema.parse(value),
        ),
        id,
      );
      if (
        grant.state !== "active" ||
        grant.component !== value.component ||
        grant.keyRevision !== value.keyRevision
      )
        throw new Error(
          "The worker encryption grant did not match the request.",
        );
      return grant;
    },
    revokeGrant: async () => {
      throw new Error("Computer-use preparation does not revoke grants.");
    },
  };
  const grants = await authorizeWorkerEncryption({
    api,
    components,
    identity: {
      ownerId: input.identity.userId,
      serverId: input.identity.serverId,
    },
    keyRevision: input.keyRevision,
    workerId: input.lease.workerId,
    service: {
      getSnapshot: () => {
        check();
        return input.service.getSnapshot();
      },
      componentKey: (options) => {
        check();
        return input.service.componentKey(options);
      },
    },
  });
  check();
  const refresh = workerEncryptionRefreshResultSchema.parse(
    await send(
      `/api/workers/${encodeURIComponent(input.lease.workerId)}/encryption/refresh`,
      { component: "client-control-content", keyRevision: input.keyRevision },
    ),
  );
  if (
    refresh.component !== "client-control-content" ||
    refresh.keyRevision !== input.keyRevision ||
    !refresh.status.supported ||
    refresh.status.state !== "ready" ||
    refresh.status.principalId !== grants[0]?.principalId ||
    components.some(
      (component) =>
        !refresh.status.grants.some(
          (grant) =>
            grant.component === component &&
            grant.keyRevision === input.keyRevision,
        ),
    )
  )
    throw new Error(
      "The worker has not loaded the computer-use encryption grants.",
    );
  check();
}
