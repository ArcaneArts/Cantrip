import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { AlertCountBadge, ProjectAlertTile } from "./project-alert-discovery";
it("shows singular/plural discoverability and no zero badge or tile", () => {
  expect(renderToStaticMarkup(<AlertCountBadge count={0} />)).toBe("");
  expect(
    renderToStaticMarkup(<ProjectAlertTile count={0} onOpen={vi.fn()} />),
  ).toBe("");
  expect(
    renderToStaticMarkup(<ProjectAlertTile count={1} onOpen={vi.fn()} />),
  ).toContain("1 Alert");
  expect(
    renderToStaticMarkup(
      <ProjectAlertTile count={3} selected onOpen={vi.fn()} />,
    ),
  ).toContain("3 Alerts");
  expect(renderToStaticMarkup(<AlertCountBadge count={1200} />)).toContain(
    'aria-label="1200 Alerts"',
  );
});
