export interface LicenseSummary {
  id: string;
  name: string;
  category: string;
  summary: string;
  conditions: string;
  reference?: string;
}

/** Descriptions checked against the linked GitHub Choose a License references. */
export const licenseCatalog: LicenseSummary[] = [
  {
    id: "MIT",
    name: "MIT License",
    category: "Permissive",
    summary:
      "Allows use, modification and redistribution, including commercial use and closed source projects.",
    conditions:
      "Keep the copyright and license notice. The software comes without a warranty.",
    reference: "https://choosealicense.com/licenses/mit/",
  },
  {
    id: "Apache-2.0",
    name: "Apache License 2.0",
    category: "Permissive",
    summary:
      "Allows commercial reuse and redistribution, with an express patent grant from contributors.",
    conditions:
      "Keep applicable copyright, license and attribution notices, and mark changed files. Trademark rights are not granted.",
    reference: "https://choosealicense.com/licenses/apache-2.0/",
  },
  {
    id: "BSD-2-Clause",
    name: "BSD 2-Clause License",
    category: "Permissive",
    summary:
      "Allows reuse and redistribution of source and binary versions, including in commercial projects.",
    conditions:
      "Retain the copyright, license conditions and disclaimer in redistributed source or accompanying binary materials.",
    reference: "https://choosealicense.com/licenses/bsd-2-clause/",
  },
  {
    id: "BSD-3-Clause",
    name: "BSD 3-Clause License",
    category: "Permissive",
    summary:
      "Allows commercial reuse and redistribution with the original notices and disclaimer.",
    conditions:
      "Keep the notices. The owner's or contributors' names cannot endorse derived products without written permission.",
    reference: "https://choosealicense.com/licenses/bsd-3-clause/",
  },
  {
    id: "ISC",
    name: "ISC License",
    category: "Permissive",
    summary:
      "Allows copying, modification and distribution for any purpose, with or without a fee.",
    conditions:
      "Keep the copyright and permission notice in copies. The software comes without a warranty.",
    reference: "https://choosealicense.com/licenses/isc/",
  },
  {
    id: "Unlicense",
    name: "The Unlicense",
    category: "Public domain dedication",
    summary:
      "Dedicates the work to the public domain and allows reuse, modification and distribution for any purpose.",
    conditions:
      "No license conditions are imposed. The software comes without a warranty.",
    reference: "https://choosealicense.com/licenses/unlicense/",
  },
  {
    id: "GPL-3.0-only",
    name: "GNU General Public License v3.0",
    category: "Strong copyleft",
    summary:
      "Allows use and modification, with source availability and license obligations when covered software is distributed.",
    conditions:
      "Distribute covered works under the GPL, provide corresponding source, preserve notices and identify changes. Read the full terms for details.",
    reference: "https://choosealicense.com/licenses/gpl-3.0/",
  },
  {
    id: "MPL-2.0",
    name: "Mozilla Public License 2.0",
    category: "File-level copyleft",
    summary:
      "Allows covered files to be used in a larger project under other terms, while changes to covered files stay open.",
    conditions:
      "When distributing covered files, make their source and modifications available under the MPL and preserve license notices.",
    reference: "https://choosealicense.com/licenses/mpl-2.0/",
  },
];

// SHA-256 of canonical SPDX texts; full fixtures and provenance are kept in licenses/.
export const licenseFingerprints: Record<string, string> = {
  "56959050891f7b737ac4e803051170c7197f02df73d80bd9a78d968e305bf558": "MIT",
  "948703bcf1cb4a2dafd21676dd01e40a58fe21bd9b425c000b9070eccb441092":
    "Apache-2.0",
  a63ef1112ebbd402f4b08567180951af8e947e407c24ee835882c6ffa65195d0:
    "BSD-2-Clause",
  e67a28b98bc45809b4963df778c62512492386503bfb2d148039abcf2d3525a7:
    "BSD-3-Clause",
  a2a686418bbdbf37f28aaf01ff3aef45cfe077a641470465923c8c23fcbe08f9: "ISC",
  "6cd6bc138f2d97f904f072ba438aa802e81d3c24f9783b398f148031dfe12aff":
    "Unlicense",
  "0ed00c7e341816e58a8d4cefd984960357103dc0ae37727fd0f9b7a9b6518c87":
    "GPL-3.0-only",
  da4c44c6f085e773c147576dd132ed4985b336dca115e13d73555d0aaef1f87b: "MPL-2.0",
};
