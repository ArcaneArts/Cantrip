// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useLegacyDraftResolution } from "./use-legacy-draft-resolution";
import { LegacyDraftConflict } from "./legacy-document-migration";
import { EditorDocumentSession } from "@/components/editor/document-session";

const events = vi.hoisted(() => ({ changed: () => {} }));
vi.mock("@/lib/client-session", () => ({
  onClientSessionIdentityChanged: (listener: () => void) => {
    events.changed = listener;
    return () => {
      events.changed = () => {};
    };
  },
}));
let root: Root;
let host: HTMLDivElement;
let api: ReturnType<typeof useLegacyDraftResolution>;
function Harness({ scope }: { scope: string }) {
  api = useLegacyDraftResolution(scope);
  return api.dialog;
}
async function mount() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<Harness scope="first" />));
  const doc = new EditorDocumentSession(
    JSON.stringify(["s", "o", "w", "p", "t", "a.txt"]),
    "base",
    "v1",
  );
  doc.editExternal("live secret");
  const live = await doc.captureTransfer();
  const recovered = { ...live, text: "recovered secret" };
  return new LegacyDraftConflict(live, recovered);
}
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
});
it("shows both snapshots and resolves the selected version, clearing private previews", async () => {
  const conflict = await mount();
  let result!: ReturnType<typeof api.resolve>;
  await act(async () => {
    result = api.resolve(conflict);
  });
  expect(
    [...document.querySelectorAll("textarea")].map((area) => area.value),
  ).toEqual(["live secret", "recovered secret"]);
  const button = [...document.querySelectorAll("button")].find(
    (item) => item.textContent === "Keep recovered draft",
  )!;
  await act(async () => button.click());
  await expect(result).resolves.toBe("recovered");
  expect(document.querySelectorAll("textarea")).toHaveLength(0);
});
it.each(["account", "context", "cancel"])(
  "cancels on %s changes without approving either draft",
  async (reason) => {
    const conflict = await mount();
    const oldResolve = api.resolve;
    let result!: ReturnType<typeof api.resolve>;
    await act(async () => {
      result = api.resolve(conflict);
    });
    await act(async () => {
      if (reason === "account") events.changed();
      else if (reason === "context") root.render(<Harness scope="second" />);
      else
        [...document.querySelectorAll("button")]
          .find((item) => item.textContent === "Cancel")!
          .click();
    });
    await expect(result).resolves.toBeNull();
    expect(document.querySelectorAll("textarea")).toHaveLength(0);
    if (reason !== "cancel")
      await expect(oldResolve(conflict)).resolves.toBeNull();
  },
);
