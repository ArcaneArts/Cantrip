import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { isLicenseFile } from "./license-file";
import { detectLicense } from "./license-detection";
import { licenseCatalog } from "./license-catalog";

const fixture = (id: string) =>
  readFile(new URL(`./licenses/${id}.txt`, import.meta.url), "utf8");
describe("license documents", () => {
  it.each([
    "LICENSE",
    "docs/LICENCE.txt",
    "LICENSE-MIT",
    "license.apache-2.0",
    "COPYING.GPL.md",
    "COPYING.LESSER",
    "Unlicense",
    "C:\\project\\LICENSE.md",
  ])("recognizes %s", (path) => expect(isLicenseFile(path)).toBe(true));
  it.each([
    "license.ts",
    "license.json",
    "licenses/report.md",
    "license-guide.md",
    "README.md",
    "src/licensed-code.py",
  ])("keeps %s on its ordinary route", (path) =>
    expect(isLicenseFile(path)).toBe(false),
  );
  it.each(licenseCatalog)(
    "recognizes the complete canonical $id text",
    async ({ id }) => {
      expect((await detectLicense(await fixture(id)))?.id).toBe(id);
    },
  );
  it("accepts copyright holders, headings, BOM and different wrapping without changing clauses", async () => {
    const text = (await fixture("MIT"))
      .replace(/Copyright[^\n]+/u, "Copyright (c) 2026 Arcane Arts")
      .replace(/\s+/gu, " ");
    // Real license notices retain their copyright line; rewrap the license body only.
    const body = text.slice(text.indexOf("Permission"));
    expect(
      (
        await detectLicense(
          "\uFEFF# MIT License\r\n\r\nCopyright (c) 2026 Arcane Arts\r\n\r\n" +
            body,
        )
      )?.id,
    ).toBe("MIT");
    const bsd =
      "BSD 3-Clause License\n\n" +
      (await fixture("BSD-3-Clause")).replace(
        /Copyright[^\n]+/u,
        "Copyright (c) 2026 Arcane Arts\nAll rights reserved.",
      );
    expect((await detectLicense(bsd))?.id).toBe("BSD-3-Clause");
  });
  it("does not infer permissions from titles, excerpts, changed terms or combined licenses", async () => {
    const mit = await fixture("MIT");
    for (const text of [
      "MIT License",
      "SPDX-License-Identifier: MIT",
      mit.slice(0, 100),
      mit.replace("without restriction", "for noncommercial use only"),
      mit + "\nCommercial use is prohibited.",
      mit + "\nCopyright (c) 2026 Another owner. Commercial use is prohibited.",
      mit.replace(
        /Copyright[^\n]+/u,
        "Copyright (c) 2026 Arcane Arts. Commercial use is prohibited.",
      ),
      "BSD 3-Clause Noncommercial Restrictions\n" +
        (await fixture("BSD-3-Clause")),
      mit + (await fixture("Apache-2.0")),
    ])
      expect(await detectLicense(text)).toBeNull();
  });
  it("identifies a bare reserved-rights notice without claiming an open source license", async () => {
    const license = await detectLicense(
      "Copyright (c) 2026 Arcane Arts\nAll rights reserved.\n",
    );
    expect(license?.id).toBe("all-rights-reserved");
    expect(license?.category).toBe("Copyright notice");
    expect(
      await detectLicense(
        "Copyright (c) 2026 Arcane Arts\nAll rights reserved.\nAdditional custom terms.",
      ),
    ).toBeNull();
  });
});
