export const INTERNAL_EXPLORER_EDITOR_CODE_TAB_TITLE =
  "__cantrip_internal_explorer_editor__";

export function isVisibleProjectCodeTab(title: string): boolean {
  return (
    title !== INTERNAL_EXPLORER_EDITOR_CODE_TAB_TITLE &&
    title !== "Explorer editor"
  );
}
