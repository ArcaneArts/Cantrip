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
