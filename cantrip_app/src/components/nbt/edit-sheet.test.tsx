// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { NbtTag } from "@cantrip/nbt";
import type { NbtDisplayRow, NbtDocumentClient } from "@cantrip/nbt/document";
import { NbtEditSheet } from "./edit-sheet";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined, container: HTMLDivElement | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  vi.unstubAllGlobals();
});
async function fixture() {
  let next = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++next, callback);
    return next;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frames.delete(id);
  });
  const edit = vi.fn(async () => ({ selection: "edit:1" }));
  const client = { edit } as unknown as NbtDocumentClient;
  const row = {
    node: {
      id: "node:0",
      type: NbtTag.Compound,
      parent: null,
      childCount: 0,
      ordinal: 0,
    },
    name: "",
  } as NbtDisplayRow;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      createElement(NbtEditSheet, {
        client,
        request: { action: "insert", row, revision: 0 },
        readOnly: false,
        onClose: vi.fn(),
        onApplied: vi.fn(),
      }),
    ),
  );
  return {
    edit,
    name: container.querySelector<HTMLInputElement>(
      '[aria-label="NBT property name"]',
    )!,
    type: container.querySelector<HTMLSelectElement>(
      '[aria-label="New NBT tag type"]',
    )!,
    value: container.querySelector<HTMLTextAreaElement>(
      '[aria-label="NBT edit value"]',
    )!,
    async frame() {
      await act(async () => {
        const callbacks = [...frames.values()];
        frames.clear();
        callbacks.forEach((callback) => callback(0));
      });
    },
  };
}
async function fill(
  field: HTMLInputElement | HTMLTextAreaElement,
  text: string,
) {
  await act(async () => {
    field.focus();
    const prototype =
      field instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
it("does not steal the name field's focus when the initial autofocus frame arrives late", async () => {
  const f = await fixture();
  expect(f.name.disabled).toBe(false);
  await fill(f.name, "long");
  await f.frame();
  expect(document.activeElement).toBe(f.name);
  expect(f.name.value).toBe("long");
  await act(async () => {
    f.type.value = "4";
    f.type.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await fill(f.value, "9223372036854775807");
  await act(async () =>
    container!
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(f.edit).toHaveBeenCalledWith(
    [
      {
        type: "insert",
        parent: "node:0",
        index: 0,
        name: "long",
        value: { type: NbtTag.Long, value: "9223372036854775807" },
      },
    ],
    0,
    "Edit NBT insert",
  );
});
it("initially focuses the first name field when the user has not chosen another control", async () => {
  const f = await fixture();
  await f.frame();
  expect(document.activeElement).toBe(f.name);
});
