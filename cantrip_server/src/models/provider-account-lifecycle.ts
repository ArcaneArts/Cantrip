import type { ServerRepository } from "../db/repository.js";
import type { WorkerCommandBus } from "../workers/bridge.js";
import type { AccountProviderKind } from "./account-provider.js";
import type { ProviderAccessTokenService } from "./provider-access-tokens.js";
import type {
  ProviderCredentialRevocationStatus,
  ProviderCredentialRevoker,
} from "./provider-credential-revocation.js";

interface ProviderAccountLifecycleLogger {
  info?(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
}

export interface ProviderAccountSignOutSummary {
  catalogInvalidated: boolean;
  credentialCleared: boolean;
  revocation: ProviderCredentialRevocationStatus | "not-applicable";
  workersClosed: number;
  workersFailed: number;
}

export interface ProviderAccountLifecycleOptions {
  accessTokens: Pick<
    ProviderAccessTokenService,
    "allowAccount" | "denyAccount"
  >;
  invalidateCatalog(input: {
    accountId: string;
    kind: AccountProviderKind;
    ownerId: string;
    providerId: string;
  }): Promise<void>;
  logger: ProviderAccountLifecycleLogger;
  revoker: ProviderCredentialRevoker;
}

/** Coordinates one server-authoritative sign-out across every worker. */
export class ProviderAccountLifecycleService {
  constructor(
    private readonly repository: ServerRepository,
    private readonly workers: WorkerCommandBus,
    private readonly options: ProviderAccountLifecycleOptions,
  ) {}

  async signOut(input: {
    accountId: string;
    credentialHomeKey: string;
    kind: AccountProviderKind;
    ownerId: string;
    providerId: string;
  }): Promise<ProviderAccountSignOutSummary | null> {
    const startedAtMs = Date.now();
    this.options.logger.info?.(
      {
        event: "provider.account.sign_out_started",
        subsystem: "provider-auth",
        operation: "sign-out",
        status: "started",
        accountId: input.accountId,
        providerId: input.providerId,
      },
      "Provider account sign-out started",
    );
    this.options.accessTokens.denyAccount(
      input.ownerId,
      input.providerId,
      input.accountId,
    );
    let signedOut;
    try {
      signedOut =
        await this.repository.takeModelProviderAccountCredentialForSignOut(
          input.ownerId,
          input.providerId,
          input.accountId,
        );
    } catch (error) {
      this.options.accessTokens.allowAccount(
        input.ownerId,
        input.providerId,
        input.accountId,
      );
      throw error;
    }
    if (!signedOut) {
      this.options.accessTokens.allowAccount(
        input.ownerId,
        input.providerId,
        input.accountId,
      );
      return null;
    }

    const connectedWorkers = (await this.repository.listWorkers(input.ownerId))
      .map(({ workerId }) => workerId)
      .filter((workerId) => this.workers.isConnected(workerId));
    const [revocation, catalog, workerResults] = await Promise.all([
      signedOut.credential
        ? this.options.revoker
            .revoke(signedOut.credential)
            .catch(() => "failed" as const)
        : Promise.resolve("not-applicable" as const),
      this.options
        .invalidateCatalog(input)
        .then(() => true)
        .catch(() => false),
      Promise.allSettled(
        connectedWorkers.map((workerId) =>
          this.workers.request(
            workerId,
            {
              type: "provider.auth.account.clear",
              providerId: input.providerId,
              providerKind: input.kind,
              providerAccountId: input.accountId,
              credentialHomeKey: input.credentialHomeKey,
            },
            { ownerId: input.ownerId, timeoutMs: 15_000 },
          ),
        ),
      ),
    ]);
    const workersFailed = workerResults.filter(
      ({ status }) => status === "rejected",
    ).length;
    const summary = {
      catalogInvalidated: catalog,
      credentialCleared: true,
      revocation,
      workersClosed: workerResults.length - workersFailed,
      workersFailed,
    } satisfies ProviderAccountSignOutSummary;
    if (revocation === "failed" || !catalog || workersFailed > 0) {
      this.options.logger.warn(
        {
          accountId: input.accountId,
          catalogInvalidated: catalog,
          providerId: input.providerId,
          revocation,
          workersFailed,
        },
        "Provider account sign-out completed with cleanup warnings",
      );
    }
    this.options.logger.info?.(
      {
        event: "provider.account.sign_out_completed",
        subsystem: "provider-auth",
        operation: "sign-out",
        status:
          revocation === "failed" || !catalog || workersFailed > 0
            ? "degraded"
            : "completed",
        accountId: input.accountId,
        providerId: input.providerId,
        durationMs: Date.now() - startedAtMs,
        counts: {
          workersClosed: summary.workersClosed,
          workersFailed: summary.workersFailed,
        },
        catalogInvalidated: summary.catalogInvalidated,
        credentialRevocation: summary.revocation,
      },
      "Provider account sign-out completed",
    );
    return summary;
  }
}
