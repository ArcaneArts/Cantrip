// @vitest-environment jsdom
import { act, create } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import { ProjectAlertTile } from "./project-alert-discovery";
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
it("shows failed navigation and permits retry without duplicating an in-flight open", async () => {
  let reject!: (e: Error) => void;
  const open = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((_r, j) => {
          reject = j;
        }),
    )
    .mockResolvedValue(true);
  let ui!: ReturnType<typeof create>;
  await act(async () => {
    ui = create(<ProjectAlertTile count={1} onOpen={open} />);
  });
  try {
    let first: Promise<void>;
    await act(async () => {
      first = ui.root.findByType("button").props.onClick();
      void ui.root.findByType("button").props.onClick();
    });
    expect(open).toHaveBeenCalledTimes(1);
    expect(ui.root.findByType("button").props.disabled).toBe(true);
    await act(async () => {
      reject(new Error("Workspace is attaching"));
      await first!;
    });
    expect(JSON.stringify(ui.toJSON())).toContain("Click Alerts to try again");
    await act(async () => {
      await ui.root.findByType("button").props.onClick();
    });
    expect(open).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(ui.toJSON())).not.toContain("Could not open");
  } finally {
    await act(async () => ui.unmount());
  }
});
