import type { ManagedNativeGatewayIdentity } from "./managed-native-gateway.js";

/** A model/account change expires view capabilities without replacing the admitted execution adapter. */
export class ManagedNativeQueueScope {
  readonly identity: ManagedNativeGatewayIdentity;
  private revision = 0;
  constructor(identity: ManagedNativeGatewayIdentity) {
    this.identity = { ...identity };
  }
  capture(): () => boolean {
    const revision = this.revision;
    return () => this.revision === revision;
  }
  refresh(next: ManagedNativeGatewayIdentity): boolean {
    for (const field of Object.keys(
      this.identity,
    ) as (keyof ManagedNativeGatewayIdentity)[]) {
      if (
        field !== "modelRouteId" &&
        field !== "providerAccountId" &&
        this.identity[field] !== next[field]
      )
        throw new Error(
          "The managed queue scope cannot replace its owning native session.",
        );
    }
    if (
      next.modelRouteId === this.identity.modelRouteId &&
      next.providerAccountId === this.identity.providerAccountId
    )
      return false;
    this.identity.modelRouteId = next.modelRouteId;
    this.identity.providerAccountId = next.providerAccountId;
    this.revision++;
    return true;
  }
}
