import {
  nativeModelInventorySchema,
  type NativeModelInventory,
} from "@cantrip/protocol";
import type { RuntimeProvider } from "./protected-secrets.js";

export class NativeModelInventoryClient {
  constructor(
    private readonly options: {
      serverUrl: string;
      workerId: string;
      token(): string;
      fetch?: typeof fetch;
    },
  ) {}
  async read(
    provider: Pick<RuntimeProvider, "id" | "accountId" | "kind">,
  ): Promise<NativeModelInventory> {
    const response = await (this.options.fetch ?? fetch)(
      new URL("/api/internal/native-model-inventory", this.options.serverUrl),
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: {
          authorization: `Bearer ${this.options.token()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          workerId: this.options.workerId,
          providerId: provider.id,
          providerAccountId: provider.accountId ?? null,
        }),
      },
    );
    if (!response.ok)
      throw new Error(
        `Native model inventory returned HTTP ${response.status}.`,
      );
    const inventory = nativeModelInventorySchema.parse(await response.json());
    if (
      inventory.workerId !== this.options.workerId ||
      inventory.providerId !== provider.id ||
      inventory.providerAccountId !== (provider.accountId ?? null) ||
      inventory.providerKind !== provider.kind
    )
      throw new Error(
        "Native model inventory returned another provider/account scope.",
      );
    return inventory;
  }
}
