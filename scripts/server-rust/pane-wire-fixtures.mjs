import { workspaceLegacyLayout } from "./workspace-layout-wire-fixtures.mjs";
export function paneWireFixtures(label) {
  const layout = workspaceLegacyLayout(label);
  const legacy = {
    projectId: layout.projectId,
    revision: layout.revision,
    groups: layout.panes.map(({ region: _region, members, ...pane }) => ({
      ...pane,
      members: members.map(({ paneId, ...member }) => ({
        ...member,
        groupId: paneId,
      })),
    })),
  };
  const title = {
    revision: 12,
    titleProtection: { ...label, classification: { recordKind: "tab-group" } },
  };
  const move = {
    revision: 12,
    tabKey: "terminal:first",
    targetPaneId: null,
    targetRegion: "right",
    targetMemberPosition: 0,
  };
  const open = {
    revision: 12,
    surfaceRef: { kind: "builtin", definitionId: "git.history" },
  };
  const launcher = {
    id: "launcher:github:project-navigator:git.history",
    projectId: "github",
    location: "project-navigator",
    target: { kind: "definition", definitionId: "git.history" },
    pinned: true,
  };
  return {
    encryptedProjectPaneUpdateSchema: [title],
    encryptedTabGroupUpdateSchema: [title],
    projectPaneOrderSchema: [
      { revision: 12, region: "center", paneIds: ["a", "b"] },
    ],
    projectPaneMemberOrderSchema: [{ revision: 12, tabKeys: ["a", "b"] }],
    projectPaneMemberMoveSchema: [
      move,
      { ...move, targetPaneId: "pane", targetRegion: undefined },
      { ...move, targetRegion: "center", targetPanePosition: 0 },
    ],
    projectPaneMemberSplitSchema: [
      {
        revision: 12,
        tabKey: "terminal:first",
        targetPaneId: "pane",
        edge: "top",
      },
      {
        revision: 12,
        tabKey: "terminal:first",
        targetPaneId: "pane",
        edge: "right",
        fraction: 0.3,
      },
    ],
    projectCenterSplitResizeSchema: [{ revision: 12, fraction: 0.6 }],
    projectDockPresentationUpdateSchema: [
      {
        revision: 12,
        tabKey: "terminal:first",
        preferredMode: "split",
        splitFraction: 0.32,
        restoreFraction: 0.32,
      },
    ],
    projectSurfaceViewOpenSchema: [
      open,
      { ...open, targetPaneId: "pane" },
      { ...open, targetRegion: "center" },
    ],
    projectSurfaceViewCloseSchema: [{ revision: 12, viewId: "terminal:first" }],
    projectSurfaceViewOpenResultSchema: [
      {
        disposition: "opened",
        viewId: "terminal:first",
        paneId: "center-a",
        layout,
      },
    ],
    projectSurfaceViewCloseResultSchema: [
      { disposition: "closed", viewId: "terminal:first", layout },
    ],
    legacyProjectSurfaceViewOpenResultSchema: [
      {
        disposition: "focused",
        viewId: "terminal:first",
        paneId: "center-a",
        layout: legacy,
      },
    ],
    legacyProjectSurfaceViewCloseResultSchema: [
      {
        disposition: "already-closed",
        viewId: "terminal:first",
        layout: legacy,
      },
    ],
    legacyProjectTabLayoutWireSummarySchema: [legacy],
    tabGroupOrderSchema: [{ revision: 12, groupIds: ["a", "b"] }],
    tabGroupMemberOrderSchema: [{ revision: 12, tabKeys: ["a", "b"] }],
    tabGroupMemberMoveSchema: [
      {
        revision: 12,
        tabKey: "a",
        targetGroupId: "pane",
        targetMemberPosition: 0,
      },
      {
        revision: 12,
        tabKey: "a",
        targetGroupId: null,
        targetMemberPosition: 0,
        targetGroupPosition: 1,
      },
    ],
    projectSurfaceLauncherListSchema: [[launcher]],
    projectSurfaceLauncherSchema: [launcher],
    projectSurfaceLauncherPinSchema: [
      {
        definitionId: "git.history",
        location: "project-navigator",
        pinned: true,
      },
    ],
  };
}
