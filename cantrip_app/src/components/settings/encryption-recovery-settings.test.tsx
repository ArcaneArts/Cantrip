import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AnonymousRecoverySettingsRow } from "./encryption-recovery-settings";

describe("AnonymousRecoverySettingsRow", () => {
  it("explains that the exported file is a bearer recovery credential", () => {
    const markup = renderToStaticMarkup(
      <AnonymousRecoverySettingsRow
        error={null}
        exporting={false}
        onExport={vi.fn()}
      />,
    );

    expect(markup).toContain("Anonymous recovery");
    expect(markup).toContain("bearer recovery file");
    expect(markup).toContain("Save recovery file");
  });
});
