// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { ExplorerTextPreviewPage } from "@cantrip/protocol/surface-stream";
import { PagedTextPreview } from "./paged-text-preview";

const viewport = vi.hoisted(() => ({
  report: undefined as undefined | ((last: number, total: number) => void),
  query: undefined as undefined | ((query: string | null) => void),
  ready: true,
  error: false,
}));
vi.mock("@/components/editor/native-code-editor", () => ({
  NativeCodeEditor: ({
    session,
    onViewportChange,
    onFindQueryChange,
    findReady,
    findError,
  }: {
    session: { text: string };
    onViewportChange: (last: number, total: number) => void;
    onFindQueryChange(query: string | null): void;
    findReady: boolean;
    findError: boolean;
  }) => {
    viewport.query = onFindQueryChange;
    viewport.ready = findReady;
    viewport.error = findError;
    viewport.report = onViewportChange;
    return <pre>{session.text}</pre>;
  },
}));
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
function page(
  content: string,
  offset = 0,
  eof = false,
): ExplorerTextPreviewPage {
  return {
    path: "file.ts",
    content,
    offset,
    nextOffset: offset + content.length,
    size: 100,
    eof,
    version: "a".repeat(64),
  };
}
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  viewport.report = undefined;
});
async function fixture(
  readPage = vi.fn().mockResolvedValue(page("first")),
  active = true,
) {
  const container = document.createElement("div");
  const root = createRoot(container);
  roots.push(root);
  const render = async (nextActive = active, key = "file.ts") =>
    act(async () =>
      root.render(
        <PagedTextPreview
          key={key}
          path="file.ts"
          active={nextActive}
          readPage={readPage}
        />,
      ),
    );
  await render();
  return { container, root, render, readPage };
}
it("loads one page, retains it through rerenders, and fetches only near the visible end", async () => {
  const f = await fixture();
  expect(f.readPage).toHaveBeenCalledExactlyOnceWith(0, undefined);
  await f.render();
  await act(async () => viewport.report!(40, 10_001));
  expect(f.readPage).toHaveBeenCalledTimes(1);
  f.readPage.mockResolvedValueOnce(page("second", 5));
  await act(async () => viewport.report!(9_850, 10_001));
  expect(f.readPage).toHaveBeenLastCalledWith(5, "a".repeat(64));
  expect(f.container.querySelector("pre")!.textContent).toBe("firstsecond");
});
it("does not start page reads while hidden", async () => {
  const f = await fixture(undefined, false);
  expect(f.readPage).not.toHaveBeenCalled();
  await f.render(true);
  expect(f.readPage).toHaveBeenCalledTimes(1);
  await f.render(false);
  await act(async () => viewport.report!(10_000, 10_001));
  expect(f.readPage).toHaveBeenCalledTimes(1);
});
it("retires in-flight pages on unmount and prevents duplicate concurrent reads", async () => {
  let resolve!: (value: ExplorerTextPreviewPage) => void;
  const read = vi.fn().mockReturnValue(
    new Promise<ExplorerTextPreviewPage>((done) => {
      resolve = done;
    }),
  );
  const f = await fixture(read);
  await f.render();
  expect(read).toHaveBeenCalledTimes(1);
  await act(async () => f.root.unmount());
  roots.splice(roots.indexOf(f.root), 1);
  await act(async () => resolve(page("retired")));
  expect(f.container.textContent).toBe("");
});
it("stops automatic reads after a changed-file error and keeps the last good text", async () => {
  const f = await fixture();
  f.readPage.mockRejectedValueOnce(
    new Error("The file changed while previewing."),
  );
  await act(async () => viewport.report!(10_000, 10_001));
  expect(f.container.textContent).toContain("file changed");
  expect(f.container.querySelector("pre")!.textContent).toBe("first");
  await act(async () => viewport.report!(10_000, 10_001));
  expect(f.readPage).toHaveBeenCalledTimes(2);
});

it("loads remaining pages for a whole-file find before allowing counts", async () => {
  const f = await fixture();
  let resolve!: (page: ExplorerTextPreviewPage) => void;
  f.readPage.mockReturnValueOnce(
    new Promise<ExplorerTextPreviewPage>((done) => {
      resolve = done;
    }),
  );
  await act(async () => viewport.query!("TARGET"));
  expect(f.readPage).toHaveBeenLastCalledWith(5, "a".repeat(64));
  expect(viewport.ready).toBe(false);
  const tail = "x".repeat(89) + "TARGET";
  await act(async () => resolve(page(tail, 5, true)));
  expect(viewport.ready).toBe(true);
  expect(f.container.querySelector("pre")!.textContent).toBe("first" + tail);
  expect(f.readPage).toHaveBeenCalledTimes(2);
});
it("reports an incomplete search when a continuation fails instead of showing partial totals", async () => {
  const f = await fixture();
  f.readPage.mockRejectedValueOnce(new Error("file changed"));
  await act(async () => viewport.query!("TARGET"));
  expect(viewport.ready).toBe(false);
  expect(viewport.error).toBe(true);
  expect(f.container.querySelector("pre")!.textContent).toBe("first");
});
