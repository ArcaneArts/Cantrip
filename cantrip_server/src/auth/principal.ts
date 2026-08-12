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

function unauthenticatedPrincipal(
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
      },
): void {
  const principal =
    input.authMode === "none"
      ? anonymousPrincipal(input.localUser)
      : unauthenticatedPrincipal(input.authMode);

  app.decorateRequest("principal");
  app.addHook("onRequest", async (request) => {
    // Request decoration must receive its own immutable value before session
    // resolution starts mutating per-request state in the account milestone.
    request.principal = { ...principal } as RequestPrincipal;
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
