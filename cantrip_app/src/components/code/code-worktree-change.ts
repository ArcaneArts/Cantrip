import type { CodeHeaderState } from "./code-view";

export async function runCodeWorktreeChange({
  active,
  header,
  rebind,
}: {
  active: boolean;
  header: CodeHeaderState | null;
  rebind(): Promise<boolean>;
}): Promise<boolean> {
  if (!active) return rebind();
  if (!header || !(await header.prepareWorktreeChange())) return false;
  try {
    return await rebind();
  } finally {
    header.resumeAfterWorktreeChange();
  }
}
