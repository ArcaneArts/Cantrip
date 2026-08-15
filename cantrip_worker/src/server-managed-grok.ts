import type { ProviderAccessTokenLease } from "@cantrip/protocol";

import {
  GrokSubscriptionClient,
  type GrokSubscriptionClientOptions,
} from "./grok-subscription-client.js";
import type { ProviderAccessTokenClient } from "./provider-access-tokens.js";

function validateLease(
  lease: ProviderAccessTokenLease,
  providerId: string,
  providerAccountId: string,
): ProviderAccessTokenLease & {
  providerIdentity: { kind: "grok"; userId: string };
} {
  if (
    lease.providerKind !== "grok" ||
    lease.providerIdentity.kind !== "grok" ||
    lease.providerId !== providerId ||
    lease.providerAccountId !== providerAccountId
  ) {
    throw new Error("Server returned a mismatched Grok access lease.");
  }
  return lease as ProviderAccessTokenLease & {
    providerIdentity: { kind: "grok"; userId: string };
  };
}

/** Creates a Grok subscription client backed only by in-memory server leases. */
export function createServerManagedGrokClient(
  providerId: string,
  providerAccountId: string,
  accessTokens: ProviderAccessTokenClient,
  options: GrokSubscriptionClientOptions = {},
): GrokSubscriptionClient {
  return new GrokSubscriptionClient(async (request) => {
    const lease = validateLease(
      await accessTokens.get(providerId, providerAccountId, {
        credentialRevision: request?.credentialRevision,
        forceRefresh: request?.forceRefresh,
      }),
      providerId,
      providerAccountId,
    );
    return {
      accessToken: lease.accessToken,
      credentialRevision: lease.credentialRevision,
      email: lease.email,
      userId: lease.providerIdentity.userId,
    };
  }, options);
}
