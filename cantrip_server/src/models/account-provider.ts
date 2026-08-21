import type { ModelProviderKind } from "@cantrip/protocol";

export type AccountProviderKind = Extract<
  ModelProviderKind,
  "chatgpt" | "grok"
>;

export function isAccountProviderKind(
  kind: ModelProviderKind | string,
): kind is AccountProviderKind {
  return kind === "chatgpt" || kind === "grok";
}

export function canRefreshProviderOnWorker(
  kind: ModelProviderKind | string,
  worker:
    | {
        encryption: {
          grants: ReadonlyArray<{ component: string }>;
        };
      }
    | null
    | undefined,
): boolean {
  if (kind === "ollama") return true;
  return (
    isAccountProviderKind(kind) &&
    Boolean(
      worker?.encryption.grants.some(
        ({ component }) => component === "provider-credential",
      ),
    )
  );
}

export function accountProviderLabel(kind: AccountProviderKind): string {
  return kind === "grok" ? "Grok" : "ChatGPT";
}

export function accountProviderCatalogScope(
  kind: AccountProviderKind,
  accountId: string,
): string {
  return `${kind}-account:${accountId}`;
}

export function defaultAccountLabel(kind: AccountProviderKind): string {
  return `${accountProviderLabel(kind)} account`;
}
