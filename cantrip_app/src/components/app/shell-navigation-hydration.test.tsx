import {
  settingsBundleSchema,
  type AppMode,
  type SettingsBundle,
  type ProjectSummary,
} from "@cantrip/protocol";
import {
  QueryClient,
  QueryClientProvider,
  notifyManager,
  useQuery,
} from "@tanstack/react-query";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/api";
import { clearClientSession, setClientSession } from "@/lib/client-session";
import {
  createShellNavigationCommands,
  useAppDestinationPersistence,
  useShellNavigationState,
  useShellStartupNavigation,
} from "./shell-navigation";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const renderers: TestRenderer.ReactTestRenderer[] = [];
const clients: QueryClient[] = [];
const project = { id: "project-a" } as ProjectSummary;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function session(ownerId = "owner-a", serverId = "server-a") {
  setClientSession({
    authMode: "accounts",
    csrfToken: "q".repeat(32),
    expiresAt: null,
    serverId,
    user: {
      id: ownerId,
      kind: "account",
      displayName: "QA",
      email: "qa@example.test",
      role: "member",
    },
  });
}
function bundle(mode: AppMode | null = "chat", revision = 1): SettingsBundle {
  return settingsBundleSchema.parse({
    providers: [],
    models: [],
    preferences: {
      theme: "system",
      highContrast: false,
      proMode: false,
      proModeOpacity: 100,
      sidebarWidth: 280,
      desktopFrameRate: 30,
      desktopStreamQuality: "balanced",
      defaultModelId: null,
      lastAppMode: mode,
      lastIdeProjectId: "project-a",
      destinationRevision: revision,
    },
  });
}
function destination(mode: AppMode, revision = 2) {
  return {
    lastAppMode: mode,
    lastIdeProjectId: "project-a",
    lastIdeWorkspaceId: null,
    lastStandaloneChatId: null,
    revision,
  };
}
beforeEach(() => {
  notifyManager.setNotifyFunction((callback) => {
    act(callback);
  });
  const items = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => items.set(key, value),
    removeItem: (key: string) => items.delete(key),
  };
  vi.stubGlobal("localStorage", localStorage);
  vi.stubGlobal("window", {
    localStorage,
    dispatchEvent: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  session();
});
afterEach(async () => {
  for (const renderer of renderers.splice(0))
    await act(async () => renderer.unmount());
  for (const client of clients.splice(0)) client.clear();
  clearClientSession();
  vi.restoreAllMocks();
  notifyManager.setNotifyFunction((callback) => callback());
  vi.unstubAllGlobals();
});

async function mount({
  persist = false,
  projects = [project],
  initial,
  fetchSettings = () => Promise.resolve(bundle()),
}: {
  persist?: boolean;
  projects?: ProjectSummary[];
  initial?: SettingsBundle;
  fetchSettings?: () => Promise<SettingsBundle>;
} = {}) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, gcTime: Infinity },
    },
  });
  clients.push(client);
  if (initial) client.setQueryData(["settings"], initial);
  let current!: {
    navigation: ReturnType<typeof useShellNavigationState>;
    commands: ReturnType<typeof createShellNavigationCommands>;
    save: ReturnType<typeof useAppDestinationPersistence>;
    settingsReady: boolean;
  };
  function Harness() {
    const navigation = useShellNavigationState({
      isPopout: false,
      gitHistoryTarget: null,
      popoutProjectId: null,
      projectOverviewPopoutTarget: null,
    });
    const settings = useQuery({
      queryKey: ["settings"],
      queryFn: fetchSettings,
    });
    const save = useAppDestinationPersistence({
      destinationWriteRef: navigation.destinationWriteRef,
      queryClient: client,
    });
    useShellStartupNavigation({
      activeProjectWorkspaceStorageKey: "workspace",
      isPopout: false,
      navigation,
      popoutProjectId: null,
      projects: { data: projects, isSuccess: true },
      projectWorkspaces: { data: [], isSuccess: true },
      standaloneChats: { data: [], isSuccess: true, isError: false },
      settings,
      selectedProjectId: navigation.selectedProjectId,
      setActiveProjectWorkspaceId: vi.fn(),
      setPendingSurfaceSelection: vi.fn(),
      setWorkspaceSelection: vi.fn(),
    });
    const commands = createShellNavigationCommands({
      activeProjectWorkspace: null,
      activeProjectWorkspaceStorageKey: "workspace",
      compactShell: false,
      isPopout: false,
      navigation,
      persistAppDestination: persist ? save : async () => {},
      projects,
      projectWorkspaces: [],
      setActiveProjectWorkspaceId: vi.fn(),
      setCommandBarOpen: vi.fn(),
      setDesktopSidebarDrawerOpen: vi.fn(),
      setFolderProjectDialogOpen: vi.fn(),
      setPendingSurfaceSelection: vi.fn(),
      setSidebarFilePreview: vi.fn(),
      setWorkspaceSelection: vi.fn(),
      settings: settings.data,
      visibleProjects: projects,
    });
    current = { navigation, commands, save, settingsReady: settings.isSuccess };
    return <span>{navigation.appMode ?? "loading"}</span>;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={client}>
        <Harness />
      </QueryClientProvider>,
    );
  });
  renderers.push(renderer);
  return {
    client,
    renderer,
    get current() {
      return current;
    },
  };
}
async function hydrated(h: Awaited<ReturnType<typeof mount>>) {
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(h.current.settingsReady).toBe(true);
  });
}

describe("startup navigation and explicit mode choices", () => {
  it.each(["ide", "chat"] as const)(
    "keeps an explicit %s selection when older settings arrive",
    async (mode) => {
      const pending = deferred<SettingsBundle>();
      const h = await mount({ fetchSettings: () => pending.promise });
      await act(async () => {
        if (mode === "ide") h.current.commands.switchToIde();
        else h.current.commands.switchToChat();
      });
      expect(h.current.navigation.appMode).toBe(mode);
      await act(async () =>
        pending.resolve(bundle(mode === "ide" ? "chat" : "ide")),
      );
      await hydrated(h);
      expect(h.current.navigation.appMode).toBe(mode);
      if (mode === "ide")
        expect(h.current.navigation.selectedProjectId).toBe(project.id);
    },
  );

  it("keeps the most recent explicit choice before hydration", async () => {
    const pending = deferred<SettingsBundle>();
    const h = await mount({ fetchSettings: () => pending.promise });
    await act(async () => h.current.commands.switchToChat());
    await act(async () => h.current.commands.switchToIde());
    await act(async () => pending.resolve(bundle("chat")));
    await hydrated(h);
    expect(h.current.navigation.appMode).toBe("ide");
  });

  it.each(["chat", "ide"] as const)(
    "still restores the saved %s mode without local interaction",
    async (mode) => {
      const pending = deferred<SettingsBundle>();
      const h = await mount({ fetchSettings: () => pending.promise });
      expect(h.current.navigation.appMode).toBeNull();
      await act(async () => pending.resolve(bundle(mode)));
      await hydrated(h);
      expect(h.current.navigation.appMode).toBe(mode);
      expect(h.current.navigation.selectedProjectId).toBe(project.id);
    },
  );

  it("defaults a fresh account without projects to Chat", async () => {
    const h = await mount({ projects: [], initial: bundle(null) });
    await hydrated(h);
    expect(h.current.navigation.appMode).toBe("chat");
  });

  it("restores the replacement account independently of the old explicit choice and late response", async () => {
    const old = deferred<SettingsBundle>();
    const first = await mount({ fetchSettings: () => old.promise });
    await act(async () => first.current.commands.switchToIde());
    await act(async () => first.renderer.unmount());
    renderers.splice(renderers.indexOf(first.renderer), 1);
    session("owner-b", "server-b");
    const next = await mount({ initial: bundle("chat") });
    await hydrated(next);
    await act(async () => old.resolve(bundle("ide")));
    expect(next.current.navigation.appMode).toBe("chat");
    expect(
      next.client.getQueryData<SettingsBundle>(["settings"])?.preferences
        .lastAppMode,
    ).toBe("chat");
  });
});

describe("destination persistence during hydration", () => {
  it.each(["owner", "server", "incarnation"])(
    "discards a pending settings read and queued write after %s replacement",
    async (change) => {
      const initial = deferred<SettingsBundle>();
      const read = deferred<SettingsBundle>();
      const get = vi.spyOn(api, "getSettings").mockReturnValue(read.promise);
      const save = vi
        .spyOn(api, "updateAppDestination")
        .mockResolvedValue(destination("ide"));
      const h = await mount({ fetchSettings: () => initial.promise });
      const first = h.current.save({ lastAppMode: "ide" });
      const queued = h.current.save({ lastAppMode: "chat" });
      await vi.waitFor(() => expect(get).toHaveBeenCalledOnce());
      if (change === "owner") session("owner-b");
      else if (change === "server") session("owner-a", "server-b");
      else {
        clearClientSession();
        session();
      }
      await act(async () => {
        read.resolve(bundle());
        await Promise.all([first, queued]);
      });
      expect(save).not.toHaveBeenCalled();
      expect(h.client.getQueryData(["settings"])).toBeUndefined();
    },
  );

  it("does not publish a late save result into the replacement identity cache", async () => {
    const saved = deferred<ReturnType<typeof destination>>();
    const save = vi
      .spyOn(api, "updateAppDestination")
      .mockReturnValue(saved.promise);
    const h = await mount({ initial: bundle() });
    const write = h.current.save({ lastAppMode: "ide" });
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    session("owner-b");
    await act(async () => {
      h.client.setQueryData(["settings"], bundle("chat", 10));
      saved.resolve(destination("ide"));
      await write;
    });
    expect(
      h.client.getQueryData<SettingsBundle>(["settings"])?.preferences,
    ).toMatchObject({ lastAppMode: "chat", destinationRevision: 10 });
  });

  it("keeps explicit navigation and persists through a genuine cross-client revision conflict", async () => {
    const pending = deferred<SettingsBundle>();
    const h = await mount({
      persist: true,
      fetchSettings: () => pending.promise,
    });
    vi.spyOn(api, "getSettings")
      .mockResolvedValueOnce(bundle("chat", 1))
      .mockResolvedValueOnce(bundle("chat", 4));
    const save = vi
      .spyOn(api, "updateAppDestination")
      .mockRejectedValueOnce(
        new api.CantripApiError("Destination changed", 409),
      )
      .mockResolvedValueOnce(destination("ide", 5));
    await act(async () => {
      h.current.commands.switchToIde();
      await h.current.navigation.destinationWriteRef.current;
    });
    await act(async () => pending.resolve(bundle("chat", 1)));
    await hydrated(h);
    expect(h.current.navigation.appMode).toBe("ide");
    expect(save.mock.calls.map(([input]) => input.expectedRevision)).toEqual([
      1, 4,
    ]);
    expect(save).toHaveBeenLastCalledWith(
      expect.objectContaining({ lastAppMode: "ide", expectedRevision: 4 }),
    );
  });
});
