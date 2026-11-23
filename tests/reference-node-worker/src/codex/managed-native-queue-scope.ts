import type { ManagedNativeGatewayIdentity } from "./managed-native-gateway.js";

/** A model/account change expires view capabilities without replacing the admitted execution adapter. */
export class ManagedNativeQueueScope {
  readonly identity: ManagedNativeGatewayIdentity;
  private revision = 0;
  private revoked = false;
  constructor(identity: ManagedNativeGatewayIdentity) {
    this.identity = { ...identity };
  }
  capture(): () => boolean {
    const revision = this.revision;
    return () => !this.revoked && this.revision === revision;
  }
  revoke(): void {
    this.revoked = true;
  }
  assertActive(): void {
    if (this.revoked) throw new Error("The managed resource was removed.");
  }
  refresh(next: ManagedNativeGatewayIdentity): boolean {
    this.assertActive();
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
