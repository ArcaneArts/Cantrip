import { CantripApiError } from "@/lib/api-client";

export type RemoteDesktopRequestAction = "create" | "load";

function remoteDesktopActionLabel(action: RemoteDesktopRequestAction): string {
  return action === "create" ? "create Remote Desktop" : "load Remote Desktop";
}

export function remoteDesktopRequestError(
  action: RemoteDesktopRequestAction,
  error: unknown,
): Error {
  if (error instanceof CantripApiError) return error;

  const actionLabel = remoteDesktopActionLabel(action);
  const message =
    error instanceof SyntaxError
      ? `The selected Cantrip Server returned an unreadable response while trying to ${actionLabel}. Try again, then check the server logs if the problem continues.`
      : `Cantrip could not reach the selected server to ${actionLabel}. Check the server connection and try again.`;

  return new Error(message, { cause: error });
}
