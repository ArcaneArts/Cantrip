import { AsyncLocalStorage } from "node:async_hooks";

import type { AuthMode } from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import { AuthenticationRequiredError } from "../../auth/principal.js";
import { LOCAL_USER_ID } from "../../db/repository.js";

export interface ApplicationOwnerContext {
  applicationOwnerId(): string;
  installRequestHook(app: FastifyInstance): void;
  runAsOwner<T>(ownerId: string, operation: () => T): T;
}

export function createApplicationOwnerContext(
  authMode: AuthMode,
): ApplicationOwnerContext {
  const ownerContext = new AsyncLocalStorage<string>();

  return {
    applicationOwnerId(): string {
      const ownerId = ownerContext.getStore();
      if (ownerId) return ownerId;
      if (authMode !== "accounts") return LOCAL_USER_ID;
      throw new AuthenticationRequiredError(
        "An explicit account owner is required outside a request context.",
      );
    },
    installRequestHook(app): void {
      app.addHook("onRequest", (request, _reply, done) => {
        if (
          request.method === "OPTIONS" ||
          request.principal.state !== "authenticated"
        ) {
          done();
          return;
        }
        ownerContext.run(request.principal.user.id, done);
      });
    },
    runAsOwner<T>(ownerId: string, operation: () => T): T {
      return ownerContext.run(ownerId, operation);
    },
  };
}
