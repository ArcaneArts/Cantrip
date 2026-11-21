import type {
  RemoteDesktopClientMessage,
  RemoteDesktopTarget,
} from "@cantrip/protocol";

function modifierNames(modifiers: number): string[] {
  return [
    ...(modifiers & 2 ? ["ctrl"] : []),
    ...(modifiers & 1
      ? [process.platform === "darwin" ? "option" : "alt"]
      : []),
    ...(modifiers & 8 ? ["shift"] : []),
    ...(modifiers & 4
      ? [process.platform === "darwin" ? "command" : "win"]
      : []),
  ];
}

function normalizedKey(key: string): string {
  const names: Record<string, string> = {
    " ": "space",
    ArrowDown: "down",
    ArrowLeft: "left",
    ArrowRight: "right",
    ArrowUp: "up",
    Backspace: "backspace",
    Delete: "delete",
    End: "end",
    Enter: "return",
    Escape: "escape",
    Home: "home",
    PageDown: "pagedown",
    PageUp: "pageup",
    Tab: "tab",
  };
  return names[key] ?? key.toLowerCase();
}

export function desktopShortcut(
  message: Extract<RemoteDesktopClientMessage, { type: "key" }>,
): string {
  return [...modifierNames(message.modifiers), normalizedKey(message.key)].join(
    "+",
  );
}

export function desktopTargetMatches(
  requested: RemoteDesktopTarget,
  active: RemoteDesktopTarget,
): boolean {
  if (requested.kind !== active.kind) return false;
  if (requested.kind === "monitor" && active.kind === "monitor") {
    return (
      (Boolean(requested.id) && requested.id === active.id) ||
      (Boolean(requested.name) && requested.name === active.name) ||
      (!requested.id && !requested.name)
    );
  }
  if (requested.kind === "window" && active.kind === "window") {
    return (
      (Boolean(requested.id) && requested.id === active.id) ||
      (Boolean(requested.title) &&
        requested.application === active.application &&
        requested.title === active.title) ||
      (!requested.id &&
        !requested.title &&
        requested.application === active.application)
    );
  }
  return false;
}

export function desktopTargetName(target: RemoteDesktopTarget): string {
  return target.kind === "window"
    ? target.title
      ? `${target.application} — ${target.title}`
      : target.application
    : (target.name ?? "primary display");
}
