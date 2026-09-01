import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { EncryptionDeviceRecoveryScreen } from "./encryption-device-recovery-screen";

describe("EncryptionDeviceRecoveryScreen", () => {
  it("explains browser reprovisioning without offering a blank reset", () => {
    const markup = renderToStaticMarkup(
      <EncryptionDeviceRecoveryScreen
        deviceLabel="browser"
        error={null}
        onRecover={vi.fn()}
      />,
    );

    expect(markup).toContain("Recover this browser");
    expect(markup).toContain("Account password");
    expect(markup).toContain('autoComplete="current-password"');
    expect(markup).toContain("restore access to the existing data");
    expect(markup).toContain("did not create a blank replacement account");
    expect(markup).not.toMatch(/reset|start over|new encryption profile/iu);
  });

  it("shows recovery failures without hiding the password flow", () => {
    const markup = renderToStaticMarkup(
      <EncryptionDeviceRecoveryScreen
        deviceLabel="installation"
        error="Password is incorrect."
        onRecover={vi.fn()}
      />,
    );

    expect(markup).toContain("Recover this installation");
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Password is incorrect.");
    expect(markup).toContain("Recover access");
  });
});
