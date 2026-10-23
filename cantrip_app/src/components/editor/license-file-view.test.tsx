// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LicenseSummary } from "./license-catalog";
const requests = vi.hoisted(
  () =>
    [] as {
      resolve(value: LicenseSummary | null): void;
      reject(error: Error): void;
    }[],
);
vi.mock("./license-detection", () => ({
  detectLicense: () =>
    new Promise((resolve, reject) => requests.push({ resolve, reject })),
}));
import { LicenseFileView } from "./license-file-view";
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  requests.length = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
it("shows the original text without a gutter immediately, ignores stale detection, and escapes markup", async () => {
  await act(async () =>
    root.render(<LicenseFileView path="LICENSE" content="old license" />),
  );
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  const latest = "<script>window.changed=true</script>\nCustom terms.";
  await act(async () =>
    root.render(<LicenseFileView path="LICENSE" content={latest} />),
  );
  await vi.waitFor(() => expect(requests).toHaveLength(2));
  expect(container.querySelector("pre")?.textContent).toBe(latest);
  expect(container.querySelector("script")).toBeNull();
  expect(container.querySelector(".cantrip-editor-gutter")).toBeNull();
  await act(async () =>
    requests[0]!.resolve({
      id: "MIT",
      name: "MIT License",
      category: "Permissive",
      summary: "old",
      conditions: "old",
    }),
  );
  expect(container.querySelector('[aria-label="License summary"]')).toBeNull();
  await act(async () => requests[1]!.resolve(null));
  expect(container.querySelector("pre")?.textContent).toBe(latest);
});
it("keeps the document visible when detection cannot run", async () => {
  await act(async () =>
    root.render(<LicenseFileView path="LICENSE" content="readable license" />),
  );
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  await act(async () => requests[0]!.reject(new Error("digest unavailable")));
  expect(container.querySelector("pre")?.textContent).toBe("readable license");
  expect(container.querySelector('[aria-label="License summary"]')).toBeNull();
});
