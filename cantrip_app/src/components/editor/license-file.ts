/** Filename routing only: a source file such as license.ts remains source code. */
export function isLicenseFile(path: string): boolean {
  const name = path.replaceAll("\\", "/").split("/").at(-1) ?? "";
  return /^(?:licen[cs]e|copying|unlicense)(?:[._-](?:txt|md|markdown|mit|apache|bsd|isc|unlicense|(?:a|l)?gpl|mpl|lesser|v?\d+(?:\.\d+)*))*$/iu.test(
    name,
  );
}

/** Ignore layout and standard copyright placeholders, never clauses or footers. */
export function canonicalLicenseText(text: string): string {
  return text
    .replace(/^\uFEFF/u, "")
    .replace(/\r\n?/gu, "\n")
    .trim()
    .replace(
      /^(?:#{1,6}[ \t]+)?(?:(?:the )?mit licen[cs]e(?: \(mit\))?|isc license|bsd [23]-clause(?: ["“](?:simplified|new|revised)["”])? license|(?:the )?unlicense)[ \t]*\n(?:[=-]+\n)?/iu,
      "",
    )
    .trimStart()
    .replace(
      /^[ \t]*(?:copyright[ \t]*(?:\(c\)|©)?|©)[ \t]+(?:\d{4}|\[(?:year|yyyy)\]|<year>)[^\n]*(?:\n|$)/iu,
      (notice) =>
        /\b(?:must|shall|except|prohibit\w*|permission|licen[cs]e\w*|noncommercial|commercial use|do not|may not)\b/iu.test(
          notice,
        )
          ? notice
          : "",
    )
    .replace(/^\s*all rights reserved\.[ \t]*(?:\n|$)/iu, "")
    .replace(/[“”]/gu, '"')
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}
