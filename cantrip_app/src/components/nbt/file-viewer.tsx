import { lazy, Suspense } from "react";
import type { FileViewerProps } from "@/components/files/file-viewers";
const Viewer = lazy(() =>
  import("./project-viewer").then((module) => ({
    default: module.NbtProjectViewer,
  })),
);
export function NbtFileViewer(props: FileViewerProps) {
  return (
    <Suspense
      fallback={
        <div className="grid h-full place-items-center text-xs text-muted-foreground">
          Opening NBT viewer…
        </div>
      }
    >
      <Viewer {...props} />
    </Suspense>
  );
}
