import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Dialog } from "@/components/ui/dialog";

import {
  GIT_LONG_PATHS_ENABLE_COMMAND,
  GIT_LONG_PATHS_VERIFY_COMMAND,
  WINDOWS_LONG_PATHS_ENABLE_COMMAND,
  WindowsLongPathDialogBody,
} from "./windows-long-path-dialog";

describe("Windows long-path guidance", () => {
  it("explains the AppData path and provides Git and Windows commands", () => {
    const markup = renderToStaticMarkup(
      <Dialog>
        <WindowsLongPathDialogBody
          pending={false}
          onClose={() => undefined}
          onRetry={() => undefined}
        />
      </Dialog>,
    );

    expect(markup).toContain("Enable long paths on the Windows worker");
    expect(markup).toContain("AppData");
    expect(markup).toContain(GIT_LONG_PATHS_ENABLE_COMMAND);
    expect(markup).toContain(GIT_LONG_PATHS_VERIFY_COMMAND);
    expect(WINDOWS_LONG_PATHS_ENABLE_COMMAND).toContain("LongPathsEnabled");
    expect(markup).toContain("New-ItemProperty");
    expect(markup).toContain("LongPathsEnabled");
    expect(markup).toContain("Retry setup");
  });
});
