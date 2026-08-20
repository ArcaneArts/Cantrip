export function SessionWindowDragRegion({ enabled }: { enabled: boolean }) {
  if (!enabled) return null;

  return (
    <div
      aria-hidden="true"
      className="fixed inset-x-0 top-0 z-50 h-8 select-none"
      data-slot="session-window-drag-region"
      data-tauri-drag-region=""
    />
  );
}
