import { projectPaneViews } from "@cantrip/protocol";
import type {
  ProjectTabLayoutSummary,
  WorkspaceOwnership,
} from "@cantrip/protocol";
import type { WorkspaceCommandClient } from "./workspace-command-client";
import {
  openWorkspaceWindowPresentation,
  workspaceWindowPresentation,
} from "./workspace-window-presentation";
import type { WorkspaceSelection } from "./workspace-selection";

type Presentation = {
  layout: ProjectTabLayoutSummary;
  selection: WorkspaceSelection;
};
export interface WorkspacePresentationState {
  presentation: Presentation | null;
  loadingLabels: boolean;
  error: unknown | null;
}

/** Session-local derived state, never persisted. Structure follows ownership
 * synchronously; asynchronous label opening cannot restore old membership. */
export class WorkspacePresentationStore {
  private state: WorkspacePresentationState = {
    presentation: null,
    loadingLabels: true,
    error: null,
  };
  private labels = new Map<string, string>();
  private listeners = new Set<() => void>();
  private generation = 0;
  private disposed = false;
  private unsubscribe: () => void;
  private projected: WorkspaceOwnership | null = null;

  constructor(
    private readonly controller: WorkspaceCommandClient,
    private readonly windowId: string,
    private readonly open = openWorkspaceWindowPresentation,
  ) {
    this.unsubscribe = controller.subscribe(this.update);
    this.update();
  }
  getSnapshot = () => this.state;
  retryLabels = () => {
    if (this.disposed) return;
    this.projected = null;
    this.update();
  };
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(state: WorkspacePresentationState) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  private update = () => {
    if (this.disposed) return;
    const source = this.controller.getSnapshot();
    if (source.disposed) {
      this.dispose();
      return;
    }
    if (source.projected === this.projected) return;
    this.projected = source.projected;
    const generation = ++this.generation;
    let projection: ReturnType<typeof workspaceWindowPresentation>;
    try {
      projection = workspaceWindowPresentation(source.projected, this.windowId);
    } catch (error) {
      this.publish({ presentation: null, loadingLabels: false, error });
      return;
    }
    const { wire, selection } = projection;
    const keys = new Set<string>();
    const key = (kind: string, id: string, envelope: unknown) => {
      const value = JSON.stringify([kind, id, envelope]);
      keys.add(value);
      return value;
    };
    const paneKeys = wire.panes.map((pane) =>
      key("pane", pane.id, pane.titleProtection),
    );
    const memberKeys = wire.panes.map((pane) =>
      projectPaneViews(pane).map((member) =>
        key(member.tabKind, member.tabId, member.titleProtection),
      ),
    );
    // Remove plaintext labels for views that are no longer owned here.
    for (const cached of this.labels.keys())
      if (!keys.has(cached)) this.labels.delete(cached);
    const layout: ProjectTabLayoutSummary = {
      ...wire,
      panes: wire.panes.map(
        ({ titleProtection: _title, conversationView, ...pane }, pi) => ({
          ...pane,
          title: this.labels.get(paneKeys[pi]!) ?? "Loading…",
          ...(conversationView
            ? {
                conversationView: {
                  ...conversationView,
                  title:
                    this.labels.get(memberKeys[pi]![pane.members.length]!) ??
                    "Loading…",
                },
              }
            : {}),
          members: pane.members.map(
            ({ titleProtection: _memberTitle, ...member }, mi) => ({
              ...member,
              title: this.labels.get(memberKeys[pi]![mi]!) ?? "Loading…",
            }),
          ),
        }),
      ),
    };
    this.publish({
      presentation: { layout, selection },
      loadingLabels: true,
      error: null,
    });
    void Promise.resolve()
      .then(() => this.open(source.projected, this.windowId))
      .then(
        (presentation) => {
          if (this.disposed || generation !== this.generation) return;
          presentation.layout.panes.forEach((pane, pi) => {
            this.labels.set(paneKeys[pi]!, pane.title);
            projectPaneViews(pane).forEach((member, mi) =>
              this.labels.set(memberKeys[pi]![mi]!, member.title),
            );
          });
          this.publish({ presentation, loadingLabels: false, error: null });
        },
        (error: unknown) => {
          if (this.disposed || generation !== this.generation) return;
          this.publish({
            presentation: this.state.presentation,
            loadingLabels: false,
            error,
          });
        },
      );
  };
  dispose = () => {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    this.unsubscribe();
    this.labels.clear();
    this.projected = null;
    this.publish({ presentation: null, loadingLabels: false, error: null });
    this.listeners.clear();
  };
}
