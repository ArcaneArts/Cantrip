import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Archive,
  FileClock,
  GitBranch,
  GitCompareArrows,
  GitPullRequestArrow,
  RotateCcw,
  Search,
  Server,
  MoreHorizontal,
  type LucideIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { NavigationTabBar } from "@/components/ui/navigation-tab-bar";
import {
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
} from "@/components/ui/styled-menu";

export type GitWorkbenchTool =
  | "operations"
  | "repository"
  | "branches"
  | "stashes"
  | "compare"
  | "file"
  | "search"
  | "recovery";

interface GitWorkbenchToolDefinition {
  icon: LucideIcon;
  id: GitWorkbenchTool;
  label: string;
}

export interface GitWorkbenchToolState {
  active: boolean;
  attention?: boolean;
  onSelect(): void;
}

export type GitWorkbenchToolStates = Record<
  GitWorkbenchTool,
  GitWorkbenchToolState
>;

export const gitWorkbenchTools: readonly GitWorkbenchToolDefinition[] = [
  { id: "operations", label: "Operations", icon: GitPullRequestArrow },
  { id: "repository", label: "Repository", icon: Server },
  { id: "branches", label: "Branches", icon: GitBranch },
  { id: "stashes", label: "Stashes", icon: Archive },
  { id: "compare", label: "Compare", icon: GitCompareArrows },
  { id: "file", label: "File", icon: FileClock },
  { id: "search", label: "Search", icon: Search },
  { id: "recovery", label: "Recovery", icon: RotateCcw },
];

export function GitWorkbenchToolbar({
  compact = false,
  disabled,
  tools,
}: {
  compact?: boolean;
  disabled: boolean;
  tools: GitWorkbenchToolStates;
}) {
  if (compact) {
    return (
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <Button
            aria-label="Open Git tools"
            className="size-6"
            disabled={disabled}
            size="icon"
            variant="ghost"
          >
            <MoreHorizontal className="size-3.5" />
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <StyledDropdownMenuContent align="end" className="min-w-48">
            {gitWorkbenchTools.map(({ icon: Icon, id, label }) => {
              const tool = tools[id];
              return (
                <StyledDropdownMenuItem
                  aria-current={tool.active ? "page" : undefined}
                  className="justify-between"
                  key={id}
                  onSelect={tool.onSelect}
                >
                  <span className="flex items-center gap-2">
                    <Icon className="size-3.5" />
                    {label}
                  </span>
                  {tool.active || tool.attention ? (
                    <span
                      aria-label={
                        tool.attention ? `${label} active` : `${label} open`
                      }
                      className={
                        tool.attention
                          ? "size-1.5 rounded-full bg-amber-500"
                          : "size-1.5 rounded-full bg-primary"
                      }
                    />
                  ) : null}
                </StyledDropdownMenuItem>
              );
            })}
          </StyledDropdownMenuContent>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    );
  }

  const activeTool = gitWorkbenchTools.find(({ id }) => tools[id].active);
  return (
    <NavigationTabBar<GitWorkbenchTool>
      activeTab={activeTool?.id ?? null}
      ariaLabel="Git tools"
      className="w-fit max-w-full"
      disabled={disabled}
      tabs={gitWorkbenchTools.map((tool) => ({
        ...tool,
        attention: tools[tool.id].attention,
      }))}
      onTabChange={(id) => tools[id].onSelect()}
    />
  );
}
