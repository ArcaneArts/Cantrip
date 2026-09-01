import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { EncryptionDeviceRecoveryScreen } from "./encryption-device-recovery-screen";
import { AnonymousRecoveryRequiredScreen } from "./anonymous-recovery-required-screen";
import { AnonymousRecoverySetupScreen } from "./anonymous-recovery-setup-screen";

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

describe("anonymous recovery screens", () => {
  it("requires the initial bearer recovery file to be saved", () => {
    const markup = renderToStaticMarkup(
      <AnonymousRecoverySetupScreen onConfirm={vi.fn()} onSave={vi.fn()} />,
    );

    expect(markup).toContain("Save anonymous recovery");
    expect(markup).toContain("only way to restore anonymous private data");
    expect(markup).toContain("Save recovery file");
    expect(markup).toContain("Continue to Cantrip");
    expect(markup).not.toMatch(/reset|blank profile/iu);
  });

  it("offers recovery-file import without destructive fallback", () => {
    const markup = renderToStaticMarkup(
      <AnonymousRecoveryRequiredScreen
        message="The installation key is unavailable."
        onImport={vi.fn()}
        onRetry={vi.fn()}
        reason="anonymous-device-missing"
      />,
    );

    expect(markup).toContain("Anonymous recovery required");
    expect(markup).toContain("Import recovery file");
    expect(markup).toContain("cryptographically unrecoverable");
    expect(markup).not.toMatch(/reset|start over/iu);
  });
});
