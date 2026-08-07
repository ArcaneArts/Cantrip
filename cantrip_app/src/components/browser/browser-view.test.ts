import { describe, expect, it } from "vitest";

import { browserUrlIsLocal } from "./browser-view";

describe("browserUrlIsLocal", () => {
  it("keeps local services out of the public page proxy", () => {
    expect(browserUrlIsLocal("http://localhost:3000/")).toBe(true);
    expect(browserUrlIsLocal("http://192.168.1.20/")).toBe(true);
    expect(browserUrlIsLocal("http://worker.local/")).toBe(true);
  });

  it("proxies public sites", () => {
    expect(browserUrlIsLocal("https://google.com/")).toBe(false);
    expect(browserUrlIsLocal("https://example.com/docs")).toBe(false);
  });
});
