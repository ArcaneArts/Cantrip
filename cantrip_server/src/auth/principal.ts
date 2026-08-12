import type {
  AuthenticationState,
  AuthMode,
  UserSummary,
} from "@cantrip/protocol";
import type { FastifyInstance, FastifyRequest } from "fastify";

export type AuthenticatedRequestPrincipal = {
  authentication: "none" | "password" | "session";
  authMode: AuthMode;
  kind: "anonymous" | "account";
  sessionId: string | null;
  state: "authenticated";
  user: UserSummary;
};

export type UnauthenticatedRequestPrincipal = {
  authentication: null;
  authMode: Exclude<AuthMode, "none">;
  kind: "unauthenticated";
  sessionId: null;
  state: "authentication-required";
  user: null;
};

export type RequestPrincipal =
  AuthenticatedRequestPrincipal | UnauthenticatedRequestPrincipal;

declare module "fastify" {
  interface FastifyRequest {
    principal: RequestPrincipal;
  }
}

export function unauthenticatedPrincipal(
  authMode: Exclude<AuthMode, "none">,
): UnauthenticatedRequestPrincipal {
  return {
    authentication: null,
    authMode,
    kind: "unauthenticated",
    sessionId: null,
    state: "authentication-required",
    user: null,
  };
}

export function sessionPrincipal(input: {
  authMode: Exclude<AuthMode, "none">;
  authentication: "password" | "session";
  sessionId: string;
  user: UserSummary;
}): AuthenticatedRequestPrincipal {
  return {
    authentication: input.authentication,
    authMode: input.authMode,
    kind: input.user.kind,
    sessionId: input.sessionId,
    state: "authenticated",
    user: input.user,
  };
}

export function anonymousPrincipal(
  user: UserSummary,
): AuthenticatedRequestPrincipal {
  if (user.kind !== "anonymous") {
    throw new Error("Anonymous authentication requires an anonymous user.");
  }
  return {
    authentication: "none",
    authMode: "none",
    kind: "anonymous",
    sessionId: null,
    state: "authenticated",
    user,
  };
}

export function installRequestPrincipal(
  app: FastifyInstance,
  input:
    | { authMode: "none"; localUser: UserSummary }
    | {
        authMode: Exclude<AuthMode, "none">;
        localUser?: never;
        resolve?: (
          request: FastifyRequest,
        ) => Promise<AuthenticatedRequestPrincipal | null>;
      },
): void {
  app.decorateRequest("principal");
  app.addHook("onRequest", async (request) => {
    if (input.authMode === "none") {
      request.principal = anonymousPrincipal(input.localUser);
      return;
    }
    request.principal =
      (await input.resolve?.(request)) ??
      unauthenticatedPrincipal(input.authMode);
  });
}

export function authenticationState(
  principal: RequestPrincipal,
): AuthenticationState {
  return principal.state;
}

export function authenticatedPrincipal(
  request: FastifyRequest,
): AuthenticatedRequestPrincipal {
  if (request.principal.state !== "authenticated") {
    throw new AuthenticationRequiredError();
  }
  return request.principal;
}

export function principalOwnerId(request: FastifyRequest): string {
  return authenticatedPrincipal(request).user.id;
}

export class AuthenticationRequiredError extends Error {
  readonly statusCode = 401;

  constructor() {
    super("Authentication is required.");
  }
}
