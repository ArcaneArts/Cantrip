import type { CuaCursorAppearance } from "@cantrip/protocol/computer-use";
import { renderToStaticMarkup } from "react-dom/server";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CursorControls, type CursorControlsProps } from "./cursor-controls";

const appearance: CuaCursorAppearance = {
  version: 1,
  style: "arrow",
  color: "#22AAFF",
  size: 24,
  label: "Cantrip",
  trail: false,
  visible: true,
};
const renderers: TestRenderer.ReactTestRenderer[] = [];

beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  for (const renderer of renderers.splice(0)) {
    await act(async () => renderer.unmount());
  }
  vi.unstubAllGlobals();
});

async function setup(overrides: Partial<CursorControlsProps> = {}) {
  const onChange = vi.fn();
  const props = { appearance, onChange, ...overrides };
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<CursorControls {...props} />);
  });
  renderers.push(renderer);
  const control = (field: string) =>
    renderer.root.find(
      (node) =>
        (node.type === "input" || node.type === "select") &&
        node.props.id?.endsWith(`-${field}`),
    );
  return {
    onChange,
    renderer,
    control,
    apply: () => renderer.root.findByType("button"),
    change: async (field: string, value: string) => {
      await act(async () =>
        control(field).props.onChange({ target: { value } }),
      );
    },
    submit: async () => {
      const preventDefault = vi.fn();
      await act(async () => {
        renderer.root.findByType("form").props.onSubmit({ preventDefault });
      });
      expect(preventDefault).toHaveBeenCalledOnce();
    },
    update: async (changes: Partial<CursorControlsProps>) => {
      Object.assign(props, changes);
      await act(async () => renderer.update(<CursorControls {...props} />));
    },
  };
}

describe("CursorControls", () => {
  it("renders labelled shared controls with all supported cursor styles", () => {
    const markup = renderToStaticMarkup(
      <CursorControls appearance={appearance} onChange={vi.fn()} />,
    );
    for (const style of ["arrow", "dot", "ring", "crosshair"]) {
      expect(markup).toContain(`<option value="${style}"`);
    }
    for (const label of [
      "Style",
      "Size",
      "Color",
      "Cursor label",
      "Show trail",
      "Show cursor",
    ]) {
      expect(markup).toContain(label);
    }
    expect(markup).toContain('data-slot="native-select"');
    expect(markup).toContain('data-slot="button"');
    expect(markup).toContain("Apply cursor");
    expect(markup).not.toContain(" title=");
  });

  it.each(["arrow", "dot", "ring", "crosshair"])(
    "commits the valid %s style only on explicit Apply",
    async (style) => {
      const controls = await setup();
      await controls.change("style", style);
      expect(controls.onChange).not.toHaveBeenCalled();
      await controls.submit();
      expect(controls.onChange).toHaveBeenCalledExactlyOnceWith({
        ...appearance,
        style,
      });
    },
  );

  it.each(["#000000", "#ffffff", "#Aa01fF", "#12345600", "#123456FF"])(
    "accepts RGB or RGBA color %s without stripping transparency",
    async (color) => {
      const controls = await setup();
      await controls.change("color", color);
      await controls.submit();
      expect(controls.onChange).toHaveBeenCalledExactlyOnceWith({
        ...appearance,
        color,
      });
    },
  );

  it.each([8, 96])("accepts size boundary %s", async (size) => {
    const controls = await setup();
    await controls.change("size", String(size));
    await controls.submit();
    expect(controls.onChange).toHaveBeenCalledExactlyOnceWith({
      ...appearance,
      size,
    });
  });

  it.each(["a".repeat(64), "😀".repeat(64)])(
    "accepts a 64-codepoint label at the ASCII or UTF-8 boundary",
    async (label) => {
      const controls = await setup();
      await controls.change("label", label);
      await controls.submit();
      expect(controls.onChange).toHaveBeenCalledExactlyOnceWith({
        ...appearance,
        label,
      });
    },
  );

  it("clears a label to null without mutating the supplied appearance", async () => {
    const frozen = Object.freeze({ ...appearance });
    const controls = await setup({ appearance: frozen });
    await controls.change("label", "");
    await controls.submit();
    expect(controls.onChange).toHaveBeenCalledExactlyOnceWith({
      ...appearance,
      label: null,
    });
    expect(frozen.label).toBe("Cantrip");
  });

  it.each([
    ["style", "triangle"],
    ["color", "#"],
    ["color", "#abc"],
    ["color", "#1234567"],
    ["color", "#123456789"],
    ["color", "red"],
    ["color", "#GG0000"],
    ["size", ""],
    ["size", "7"],
    ["size", "97"],
    ["size", "8.5"],
    ["size", "NaN"],
    ["size", "Infinity"],
    ["label", "a".repeat(65)],
    ["label", "😀".repeat(65)],
    ["label", "control\u0000"],
    ["label", "line\nbreak"],
    ["label", "delete\u007f"],
    ["label", "control\u0085"],
  ])(
    "does not emit invalid or incomplete %s value %j",
    async (field, value) => {
      const controls = await setup();
      await controls.change(field, value);
      expect(controls.apply().props.disabled).toBe(true);
      expect(controls.control(field).props["aria-invalid"]).toBe(true);
      await controls.submit();
      expect(controls.onChange).not.toHaveBeenCalled();
    },
  );

  it("can correct an incomplete draft without ever sending the partial value", async () => {
    const controls = await setup();
    await controls.change("color", "#12");
    await controls.submit();
    expect(controls.onChange).not.toHaveBeenCalled();
    await controls.change("color", "#12345678");
    expect(controls.apply().props.disabled).not.toBe(true);
    await controls.submit();
    expect(controls.onChange).toHaveBeenCalledExactlyOnceWith({
      ...appearance,
      color: "#12345678",
    });
  });

  it("applies trail and visibility together in one appearance update", async () => {
    const controls = await setup();
    const checkboxes = controls.renderer.root.findAll(
      (node) => node.type === "input" && node.props.type === "checkbox",
    );
    await act(async () =>
      checkboxes[0]!.props.onChange({ target: { checked: true } }),
    );
    await act(async () =>
      checkboxes[1]!.props.onChange({ target: { checked: false } }),
    );
    expect(controls.onChange).not.toHaveBeenCalled();
    await controls.submit();
    expect(controls.onChange).toHaveBeenCalledExactlyOnceWith({
      ...appearance,
      trail: true,
      visible: false,
    });
  });

  it("preserves an unfinished draft across equivalent remote appearance objects", async () => {
    const controls = await setup();
    await controls.change("label", "Draft label");
    await controls.update({ appearance: { ...appearance } });
    expect(controls.control("label").props.value).toBe("Draft label");
    expect(controls.onChange).not.toHaveBeenCalled();
  });

  it("replaces the draft when a different remote appearance arrives", async () => {
    const controls = await setup();
    await controls.change("label", "Stale local draft");
    const remote = { ...appearance, color: "#445566", label: "Remote" };
    await controls.update({ appearance: remote });
    expect(controls.control("label").props.value).toBe("Remote");
    expect(controls.control("color").props.value).toBe("#445566");
    expect(controls.onChange).not.toHaveBeenCalled();
    await controls.submit();
    expect(controls.onChange).toHaveBeenCalledExactlyOnceWith(remote);
  });

  it("uses the current callback without discarding an unfinished draft", async () => {
    const controls = await setup();
    const nextOnChange = vi.fn();
    await controls.change("label", "Draft label");
    await controls.update({ onChange: nextOnChange });
    await controls.submit();
    expect(controls.onChange).not.toHaveBeenCalled();
    expect(nextOnChange).toHaveBeenCalledExactlyOnceWith({
      ...appearance,
      label: "Draft label",
    });
  });

  it("disables every input and suppresses submission while preserving the draft", async () => {
    const controls = await setup();
    await controls.change("label", "Unsent draft");
    await controls.update({ disabled: true });
    for (const node of controls.renderer.root.findAll(
      (node) =>
        node.type === "input" ||
        node.type === "select" ||
        node.type === "button",
    )) {
      expect(node.props.disabled).toBe(true);
    }
    await controls.submit();
    expect(controls.onChange).not.toHaveBeenCalled();
    await controls.update({ disabled: false });
    expect(controls.control("label").props.value).toBe("Unsent draft");
    await controls.submit();
    expect(controls.onChange).toHaveBeenCalledExactlyOnceWith({
      ...appearance,
      label: "Unsent draft",
    });
  });
});
