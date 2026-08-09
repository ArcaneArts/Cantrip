export type DefaultProjectTab = {
  id: string;
  kind: "browser" | "chat" | "code" | "explorer" | "terminal" | "view";
};

interface PositionedTab {
  id: string;
  position: number;
}

interface TerminalTab extends PositionedTab {
  linkedChatId: string | null;
}

interface ProjectViewTab extends PositionedTab {
  kind: string;
}

export function selectDefaultProjectTab(input: {
  browsers: PositionedTab[];
  chats: PositionedTab[];
  codeTabs: PositionedTab[];
  explorers: PositionedTab[];
  projectViews: ProjectViewTab[];
  terminals: TerminalTab[];
}): DefaultProjectTab | null {
  const first = [
    ...input.chats.map((chat) => ({
      id: chat.id,
      kind: "chat" as const,
      position: chat.position,
    })),
    ...input.terminals.flatMap((terminal) =>
      terminal.linkedChatId
        ? []
        : [
            {
              id: terminal.id,
              kind: "terminal" as const,
              position: terminal.position,
            },
          ],
    ),
    ...input.explorers.map((explorer) => ({
      id: explorer.id,
      kind: "explorer" as const,
      position: explorer.position,
    })),
    ...input.browsers.map((browser) => ({
      id: browser.id,
      kind: "browser" as const,
      position: browser.position,
    })),
    ...input.codeTabs.map((codeTab) => ({
      id: codeTab.id,
      kind: "code" as const,
      position: codeTab.position,
    })),
    ...input.projectViews.flatMap((view) =>
      view.kind === "remote-desktop"
        ? []
        : [
            {
              id: view.id,
              kind: "view" as const,
              position: view.position,
            },
          ],
    ),
  ].sort((left, right) => left.position - right.position)[0];

  return first ? { id: first.id, kind: first.kind } : null;
}
