import {
  cuaCursorAppearanceSchema,
  type CuaCursorAppearance,
} from "@cantrip/protocol/computer-use";
import {
  cuaCursorPreferenceContext,
  cuaCursorPreferenceRecordSchema,
} from "@cantrip/protocol/computer-use-preferences";
import { settingsBundleWireSchema } from "@cantrip/protocol";
import { request } from "./api-client";
import { clientEncryption } from "./client-encryption";
import {
  clientSessionIdentityMatches,
  getClientSessionIdentitySnapshot,
} from "./client-session";
import {
  openEndpointContent,
  protectEndpointContent,
} from "./endpoint-content-encryption";

export interface ComputerUseCursorPreferences {
  load(signal: AbortSignal): Promise<CuaCursorAppearance | null>;
  save(
    appearance: CuaCursorAppearance | null,
    signal: AbortSignal,
  ): Promise<void>;
}

/** The same account settings path as ordinary preferences, with an opaque
 * appearance so labels never become plaintext server settings or diagnostics. */
export function createComputerUseCursorPreferences(
  dependencies: {
    request?: typeof request;
    identity?: typeof getClientSessionIdentitySnapshot;
    matches?: typeof clientSessionIdentityMatches;
    encryption?: Pick<typeof clientEncryption, "getSnapshot">;
    protect?: typeof protectEndpointContent;
    open?: typeof openEndpointContent;
  } = {},
): ComputerUseCursorPreferences {
  const identity = (
    dependencies.identity ?? getClientSessionIdentitySnapshot
  )();
  const encryption = dependencies.encryption ?? clientEncryption;
  const keyRevision = encryption.getSnapshot().masterKeyRevision;
  const matches = dependencies.matches ?? clientSessionIdentityMatches;
  const send = dependencies.request ?? request;
  const protect = dependencies.protect ?? protectEndpointContent;
  const open = dependencies.open ?? openEndpointContent;
  function assertActive(signal: AbortSignal) {
    signal.throwIfAborted();
    const current = encryption.getSnapshot();
    if (
      !identity ||
      !matches(identity) ||
      !keyRevision ||
      current.status !== "ready" ||
      current.masterKeyRevision !== keyRevision
    ) {
      throw new Error("The account or encryption identity changed.");
    }
  }
  async function settings(init: RequestInit, signal: AbortSignal) {
    assertActive(signal);
    const value = await send(
      "/api/settings",
      {
        ...init,
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      },
      { expectedIdentity: identity!, allowCsrfRecovery: false },
    );
    assertActive(signal);
    return settingsBundleWireSchema.parse(value);
  }
  return {
    async load(signal) {
      const bundle = await settings({}, signal);
      const record = bundle.preferences.protectedComputerUseCursor;
      if (!record) return null;
      const appearance = await open({
        context: cuaCursorPreferenceContext(record.operationId),
        opaque: record.protectedContent,
        schema: cuaCursorAppearanceSchema,
      });
      assertActive(signal);
      return appearance;
    },
    async save(appearance, signal) {
      assertActive(signal);
      const operationId = crypto.randomUUID();
      const record =
        appearance === null
          ? null
          : cuaCursorPreferenceRecordSchema.parse({
              operationId,
              protectedContent: await protect({
                context: cuaCursorPreferenceContext(operationId),
                content: cuaCursorAppearanceSchema.parse(appearance),
                schema: cuaCursorAppearanceSchema,
              }),
            });
      assertActive(signal);
      await settings(
        {
          method: "PATCH",
          body: JSON.stringify({ protectedComputerUseCursor: record }),
        },
        signal,
      );
    },
  };
}
