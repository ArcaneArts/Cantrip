import { describe, expect, it } from "vitest";

import {
  injectBrowserBridge,
  validatePublicBrowserUrl,
} from "../src/browser-proxy.js";

describe("browser proxy safety", () => {
  it("rejects local destinations and embedded credentials", async () => {
    await expect(
      validatePublicBrowserUrl("http://127.0.0.1:4310"),
    ).rejects.toThrow(/Private/);
    await expect(
      validatePublicBrowserUrl("http://192.168.1.2"),
    ).rejects.toThrow(/Private/);
    await expect(
      validatePublicBrowserUrl("https://user:secret@example.com"),
    ).rejects.toThrow(/credentials/);
  });

  it("accepts public literal addresses without DNS access", async () => {
    await expect(
      validatePublicBrowserUrl("https://8.8.8.8/"),
    ).resolves.toMatchObject({ protocol: "https:", hostname: "8.8.8.8" });
  });

  it("injects the page base and navigation bridge", () => {
    const html = injectBrowserBridge(
      "<html><head><title>Page</title></head><body></body></html>",
      "https://example.com/docs/",
    );
    expect(html).toContain('<base href="https://example.com/docs/">');
    expect(html).toContain("cantrip-browser-navigate");
    expect(html.indexOf("<base")).toBeLessThan(html.indexOf("<title>"));
  });
});
