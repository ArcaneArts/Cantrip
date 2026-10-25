import type { TaskDetail } from "@cantrip/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { TaskDispatchStatus } from "./task-dispatch-status";

type Dispatch = NonNullable<TaskDetail["dispatch"]>;
function render(
  state: Dispatch["state"],
  code: Dispatch["eligibilityCode"],
  paused = false,
) {
  return renderToStaticMarkup(
    <TaskDispatchStatus
      dispatch={{ state, eligibilityCode: code } as Dispatch}
      paused={paused}
    />,
  );
}

it("presents queued authorization as a wait, not an encryption failure", () => {
  const html = render("queued", "encryption-grant-unavailable");
  expect(html).toContain("Waiting for worker authorization");
  expect(html).toContain('role="status"');
  expect(html).toContain("animate-spin");
  expect(html).toContain("saved in the queue");
  expect(html).not.toContain("Encryption Grant Unavailable");
  expect(html).not.toContain("text-amber");
});

it("does not imply progress while paused", () => {
  const html = render("queued", "encryption-grant-unavailable", true);
  expect(html).toContain("Worker authorization pending (paused)");
  expect(html).not.toContain("animate-spin");
});

it("retains a real dispatch failure and other eligibility warnings", () => {
  const html = render("failed", "encryption-grant-unavailable");
  expect(html).toContain("Encryption Grant Unavailable");
  expect(html).toContain("text-amber");
  expect(html).not.toContain("animate-spin");
  expect(render("queued", "worker-offline")).toContain("Worker Offline");
});

it("removes the wait when the scheduler clears the reason", () => {
  expect(render("queued", null)).toBe("");
  expect(render("running", null)).toBe("");
  expect(renderToStaticMarkup(<TaskDispatchStatus dispatch={null} />)).toBe("");
});
