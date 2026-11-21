import type { CantripMcpBinding } from "@cantrip/protocol";
import {
  cuaAgentAuthorityRequestSchema,
  cuaAgentAuthoritySchema,
  type CuaAgentAuthority,
} from "@cantrip/protocol/computer-use-agent";
import { readBoundedJsonResponse } from "../mcp/http.js";

export class CuaAuthorityError extends Error {
  constructor(
    readonly code: "unauthorized" | "unavailable" | "invalid-response",
  ) {
    super(
      {
        unauthorized: "Computer-use execution is no longer authorized.",
        unavailable: "Computer-use authorization is unavailable.",
        "invalid-response":
          "The server returned invalid computer-use authority.",
      }[code],
    );
    this.name = "CuaAuthorityError";
  }
}

/** No cached authority or retries: each call obtains the actual server decision. */
export async function requestComputerUseAuthority(input: {
  binding: CantripMcpBinding;
  serverUrl: string;
  token: string;
  signal: AbortSignal;
}): Promise<CuaAgentAuthority> {
  // Snapshot the authenticated attachment before the await; a broker renewal
  // must not retarget a request that was already sent for the previous lane.
  const request = cuaAgentAuthorityRequestSchema.parse({
    binding: input.binding,
  });
  const binding = request.binding;
  const body = JSON.stringify(request);
  let response: Response;
  try {
    response = await fetch(
      new URL("/api/internal/computer-use/authority", input.serverUrl),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.token}`,
          "content-type": "application/json",
        },
        body,
        signal: AbortSignal.any([input.signal, AbortSignal.timeout(10_000)]),
      },
    );
  } catch {
    input.signal.throwIfAborted();
    throw new CuaAuthorityError("unavailable");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new CuaAuthorityError(
      response.status === 401 || response.status === 409
        ? "unauthorized"
        : "unavailable",
    );
  }
  let payload: unknown;
  try {
    payload = await readBoundedJsonResponse(response, 16 * 1024);
  } catch {
    input.signal.throwIfAborted();
    throw new CuaAuthorityError("invalid-response");
  }
  // A final body read may settle in the same turn as Stop. Never publish its
  // otherwise-valid authority after the calling operation was cancelled.
  input.signal.throwIfAborted();
  const parsed = cuaAgentAuthoritySchema.safeParse(payload);
  if (!parsed.success) throw new CuaAuthorityError("invalid-response");
  const authority = parsed.data;
  if (
    authority.ownerId !== binding.ownerId ||
    authority.workerId !== binding.workerId ||
    authority.chatId !== binding.chatId ||
    authority.projectId !== binding.projectId ||
    authority.contextKind !== binding.contextKind ||
    authority.executionLaneId !== binding.executionLaneId ||
    authority.placementId !==
      (binding.contextKind === "project"
        ? binding.worktreeId
        : binding.scratchRootId)
  )
    throw new CuaAuthorityError("invalid-response");
  return parsed.data;
}
