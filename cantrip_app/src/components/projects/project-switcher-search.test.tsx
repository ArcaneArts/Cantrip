// @vitest-environment jsdom
import type {
  ProjectSummary,
  ProjectWorkspaceSummary,
} from "@cantrip/protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ProjectSwitcher } from "./project-switcher";

vi.mock("@/lib/project-recency", () => ({
  useRecentProjectIds: () => [],
  recordProjectAccess: vi.fn(),
}));
const timestamp = "2026-10-08T00:00:00Z";
function folder(id: string): ProjectSummary {
  return {
    id,
    name: "WQA duplicate ✓",
    position: 0,
    originKind: "managed-folder",
    folderManagement: "managed",
    capabilities: {
      git: false,
      github: false,
      worktrees: false,
      replicas: false,
      relocation: false,
    },
    setupStatus: "ready",
    setupError: null,
    worktreePolicy: "agent-managed",
    github: null,
    source: {
      id: `source-${id}`,
      sourceKind: "folder",
      workerId: "worker",
      path: `/qa/folders/${id}`,
      displayPath: `/qa/folders/${id}`,
      placementMode: "managed",
      ownershipKind: "cantrip",
      requestedPath: null,
      linkPath: null,
    },
    replicas: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
const projects: ProjectSummary[] = [
  folder("first"),
  folder("second"),
  {
    ...folder("repo"),
    name: "Repository",
    originKind: "github",
    folderManagement: null,
    capabilities: {
      git: true,
      github: true,
      worktrees: true,
      replicas: true,
      relocation: true,
    },
    github: {
      repositoryId: "repository",
      nameWithOwner: "qa/repository",
      url: "https://github.com/qa/repository",
    },
    source: null,
  },
];
const workspaces = [
  {
    id: "qa",
    name: "QA workspace",
    isDefault: true,
    projectIds: ["first", "second"],
  },
  {
    id: "other",
    name: "Other workspace",
    isDefault: false,
    projectIds: ["repo"],
  },
] as ProjectWorkspaceSummary[];
let root: Root;
let container: HTMLDivElement;
const select = vi.fn();
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  HTMLElement.prototype.scrollIntoView = vi.fn();
  select.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <TooltipProvider>
        <ProjectSwitcher
          activeWorkspaceId="qa"
          projects={projects}
          selectedProjectId={null}
          workspaces={workspaces}
          onAddProject={() => {}}
          onManageWorkspaces={() => {}}
          onOpenProjectSettings={() => {}}
          onRemoveProject={async () => {}}
          onSelectProject={select}
          onSelectWorkspace={() => {}}
        />
      </TooltipProvider>,
    ),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function open() {
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="Switch project"]')!
      .click(),
  );
}
async function search(value: string) {
  const input = document.querySelector<HTMLInputElement>(
    '[aria-label="Search all projects"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const options = () => [
  ...document.querySelectorAll<HTMLElement>('[role="option"]'),
];
describe("project switcher source context", () => {
  it("keeps duplicate project source paths when searching and selects either identity", async () => {
    for (const [index, id] of ["first", "second"].entries()) {
      await open();
      await search("WQA duplicate");
      expect(options()).toHaveLength(2);
      for (const project of projects.slice(0, 2)) {
        const row = options().find((row) =>
          row.textContent?.includes(project.source!.displayPath),
        );
        expect(row?.textContent).toContain("QA workspace");
        expect(row?.textContent).toContain("WQA duplicate ✓");
      }
      expect(options()[0]!.textContent).not.toBe(options()[1]!.textContent);
      await act(async () => options()[index]!.click());
      expect(select).toHaveBeenLastCalledWith(id);
    }
  });
  it("retains source context without a query and workspace plus repository across workspaces", async () => {
    await open();
    expect(options().map((row) => row.textContent)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("/qa/folders/first"),
        expect.stringContaining("/qa/folders/second"),
      ]),
    );
    await search("Repository");
    expect(options()).toHaveLength(1);
    expect(options()[0]!.textContent).toContain("Other workspace");
    expect(options()[0]!.textContent).toContain("qa/repository");
  });
});
