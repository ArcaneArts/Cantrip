import { canonicalLicenseText } from "./license-file";
import {
  licenseCatalog,
  licenseFingerprints,
  type LicenseSummary,
} from "./license-catalog";

const reserved: LicenseSummary = {
  id: "all-rights-reserved",
  name: "All rights reserved",
  category: "Copyright notice",
  summary: "Copyright is reserved by the named owner.",
  conditions: "Read the notice below for the applicable terms.",
};

/** Exact normalized body matches only. Names, SPDX tags and excerpts are insufficient. */
export async function detectLicense(
  text: string,
): Promise<LicenseSummary | null> {
  if (
    /^\s*(?:(?:copyright|©)[^\r\n]+\r?\n\s*)+all rights reserved\.?\s*$/iu.test(
      text,
    )
  )
    return reserved;
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalLicenseText(text)),
  );
  const hash = Array.from(new Uint8Array(bytes), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
  const id = licenseFingerprints[hash];
  return licenseCatalog.find((license) => license.id === id) ?? null;
}
