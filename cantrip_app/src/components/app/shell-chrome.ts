import type { QueryClient } from "@tanstack/react-query";
import { useMutation } from "@tanstack/react-query";
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { updateSettings } from "@/lib/api";
import { clientLogger, operationalErrorMetadata } from "@/lib/client-log-relay";
import { hasScrolledContent } from "@/lib/scroll-divider";
import {
  clampSidebarWidth,
  DEFAULT_SIDEBAR_WIDTH,
  sidebarWidthFromKey,
  sidebarWidthFromPointer,
} from "@/lib/sidebar-resize";

export function useShellChromeState({
  desktopSidebarDrawer,
}: {
  desktopSidebarDrawer: boolean;
}) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [desktopSidebarDrawerOpen, setDesktopSidebarDrawerOpen] =
    useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const [contentScrolled, setContentScrolled] = useState(false);
  const contentRootRef = useRef<HTMLElement>(null);
  const scrolledContentRef = useRef(new Set<EventTarget>());
  const sidebarRef = useRef<HTMLElement>(null);
  const sidebarWidthRef = useRef(DEFAULT_SIDEBAR_WIDTH);
  const sidebarResizePointerIdRef = useRef<number | null>(null);
  const sidebarResizeLeftRef = useRef(0);
  const sidebarResizeStartWidthRef = useRef(DEFAULT_SIDEBAR_WIDTH);
  const sidebarResizeBodyStyleRef = useRef<{
    cursor: string;
    userSelect: string;
  } | null>(null);

  useEffect(() => {
    if (!desktopSidebarDrawer) setDesktopSidebarDrawerOpen(false);
  }, [desktopSidebarDrawer]);

  useEffect(() => {
    if (!desktopSidebarDrawerOpen) return;
    sidebarRef.current?.focus();
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setDesktopSidebarDrawerOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [desktopSidebarDrawerOpen]);

  return {
    contentRootRef,
    contentScrolled,
    desktopSidebarDrawerOpen,
    scrolledContentRef,
    setContentScrolled,
    setDesktopSidebarDrawerOpen,
    setSidebarCollapsed,
    setSidebarResizing,
    setSidebarWidth,
    sidebarCollapsed,
    sidebarRef,
    sidebarResizeBodyStyleRef,
    sidebarResizeLeftRef,
    sidebarResizePointerIdRef,
    sidebarResizeStartWidthRef,
    sidebarResizing,
    sidebarWidth,
    sidebarWidthRef,
  } as const;
}

type ShellChromeState = ReturnType<typeof useShellChromeState>;

export function useSidebarWidthPersistence(queryClient: QueryClient) {
  return useMutation({
    mutationFn: (width: number) => updateSettings({ sidebarWidth: width }),
    onSuccess: (bundle) => queryClient.setQueryData(["settings"], bundle),
    onError: (error) => {
      clientLogger.warn("Sidebar width failed to save", {
        ...operationalErrorMetadata(error),
        event: "settings.sidebar-width.save.failed",
        operation: "save-setting",
        reasonCode: "request-failed",
        status: "rolled-back",
        subsystem: "settings",
      });
    },
  });
}

export function useContentScrollChrome({
  activeContentKey,
  contentRootRef,
  isPopout,
  scrolledContentRef,
  setContentScrolled,
}: Pick<
  ShellChromeState,
  "contentRootRef" | "scrolledContentRef" | "setContentScrolled"
> & {
  activeContentKey: string;
  isPopout: boolean;
}) {
  useEffect(() => {
    scrolledContentRef.current.clear();
    setContentScrolled(false);
  }, [activeContentKey, scrolledContentRef, setContentScrolled]);
  useEffect(() => {
    const root = contentRootRef.current;
    if (!root || isPopout) return;
    const update = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Node) || !root.contains(target)) return;
      const scrolled = scrolledContentRef.current;
      for (const candidate of scrolled) {
        if (!(candidate instanceof Node) || !root.contains(candidate)) {
          scrolled.delete(candidate);
        }
      }
      if (hasScrolledContent(target)) scrolled.add(target);
      else scrolled.delete(target);
      setContentScrolled(scrolled.size > 0);
    };
    root.addEventListener("scroll", update, true);
    return () => root.removeEventListener("scroll", update, true);
  }, [contentRootRef, isPopout, scrolledContentRef, setContentScrolled]);
}

export function useSidebarResizeController({
  configuredWidth,
  saveSidebarWidth,
  setSidebarResizing,
  setSidebarWidth,
  sidebarRef,
  sidebarResizeBodyStyleRef,
  sidebarResizeLeftRef,
  sidebarResizePointerIdRef,
  sidebarResizeStartWidthRef,
  sidebarWidthRef,
}: Pick<
  ShellChromeState,
  | "setSidebarResizing"
  | "setSidebarWidth"
  | "sidebarRef"
  | "sidebarResizeBodyStyleRef"
  | "sidebarResizeLeftRef"
  | "sidebarResizePointerIdRef"
  | "sidebarResizeStartWidthRef"
  | "sidebarWidthRef"
> & {
  configuredWidth: number | undefined;
  saveSidebarWidth: { mutate(width: number): void };
}) {
  useEffect(() => {
    if (
      sidebarResizePointerIdRef.current !== null ||
      configuredWidth === undefined
    ) {
      return;
    }
    const width = clampSidebarWidth(configuredWidth);
    sidebarWidthRef.current = width;
    setSidebarWidth(width);
  }, [
    configuredWidth,
    setSidebarWidth,
    sidebarResizePointerIdRef,
    sidebarWidthRef,
  ]);
  useEffect(
    () => () => {
      const previous = sidebarResizeBodyStyleRef.current;
      if (!previous) return;
      document.body.style.cursor = previous.cursor;
      document.body.style.userSelect = previous.userSelect;
    },
    [sidebarResizeBodyStyleRef],
  );

  const applySidebarWidth = (width: number) => {
    const next = clampSidebarWidth(width);
    sidebarWidthRef.current = next;
    setSidebarWidth(next);
    return next;
  };

  const restoreSidebarResizeBodyStyle = () => {
    const previous = sidebarResizeBodyStyleRef.current;
    if (!previous) return;
    document.body.style.cursor = previous.cursor;
    document.body.style.userSelect = previous.userSelect;
    sidebarResizeBodyStyleRef.current = null;
  };

  const beginSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    sidebarResizePointerIdRef.current = event.pointerId;
    sidebarResizeLeftRef.current =
      sidebarRef.current?.getBoundingClientRect().left ?? 0;
    sidebarResizeStartWidthRef.current = sidebarWidthRef.current;
    sidebarResizeBodyStyleRef.current = {
      cursor: document.body.style.cursor,
      userSelect: document.body.style.userSelect,
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    event.currentTarget.setPointerCapture(event.pointerId);
    setSidebarResizing(true);
  };

  const moveSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (sidebarResizePointerIdRef.current !== event.pointerId) return;
    applySidebarWidth(
      sidebarWidthFromPointer(event.clientX, sidebarResizeLeftRef.current),
    );
  };

  const finishSidebarResize = (
    event: ReactPointerEvent<HTMLDivElement>,
    persist: boolean,
  ) => {
    if (sidebarResizePointerIdRef.current !== event.pointerId) return;
    sidebarResizePointerIdRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    restoreSidebarResizeBodyStyle();
    setSidebarResizing(false);
    if (!persist) {
      applySidebarWidth(sidebarResizeStartWidthRef.current);
      return;
    }
    if (sidebarWidthRef.current !== sidebarResizeStartWidthRef.current) {
      saveSidebarWidth.mutate(sidebarWidthRef.current);
    }
  };

  const resizeSidebarWithKeyboard = (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => {
    const next = sidebarWidthFromKey(sidebarWidthRef.current, event.key);
    if (next === null) return;
    event.preventDefault();
    if (next === sidebarWidthRef.current) return;
    applySidebarWidth(next);
    saveSidebarWidth.mutate(next);
  };

  return {
    beginSidebarResize,
    finishSidebarResize,
    moveSidebarResize,
    resizeSidebarWithKeyboard,
  } as const;
}
