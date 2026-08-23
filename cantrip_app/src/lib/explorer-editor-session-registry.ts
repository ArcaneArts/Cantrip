const activeCodeTabIds = new Set<string>();

export function registerActiveExplorerEditorCodeTab(codeTabId: string): void {
  activeCodeTabIds.add(codeTabId);
}

export function unregisterActiveExplorerEditorCodeTab(codeTabId: string): void {
  activeCodeTabIds.delete(codeTabId);
}

export function isActiveExplorerEditorCodeTab(codeTabId: string): boolean {
  return activeCodeTabIds.has(codeTabId);
}
