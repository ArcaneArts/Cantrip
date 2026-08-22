import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ServerVersionBadge,
  serverVersionCompatibility,
} from "./server-switcher";

describe("server switcher versions", () => {
  it("classifies exact versions as matching and other versions as mismatched", () => {
    expect(serverVersionCompatibility("1.1.10", "1.1.10")).toBe("matching");
    expect(serverVersionCompatibility("1.1.9", "1.1.10")).toBe("mismatched");
    expect(serverVersionCompatibility(null, "1.1.10")).toBe("unavailable");
    expect(serverVersionCompatibility(undefined, "1.1.10")).toBe("loading");
  });

  it("renders green matching and orange mismatched version badges", () => {
    const matching = renderToStaticMarkup(
      <ServerVersionBadge clientVersion="1.1.10" serverVersion="1.1.10" />,
    );
    const mismatched = renderToStaticMarkup(
      <ServerVersionBadge clientVersion="1.1.10" serverVersion="1.1.9" />,
    );

    expect(matching).toContain('data-version-compatibility="matching"');
    expect(matching).toContain('aria-label="Server v1.1.10 matches this app."');
    expect(matching).toContain("text-emerald-600");
    expect(matching).toContain(">v1.1.10</span>");
    expect(mismatched).toContain('data-version-compatibility="mismatched"');
    expect(mismatched).toContain("text-orange-600");
    expect(mismatched).toContain(">v1.1.9</span>");
    expect(mismatched).toContain("differs from this app (v1.1.10)");
  });
});
