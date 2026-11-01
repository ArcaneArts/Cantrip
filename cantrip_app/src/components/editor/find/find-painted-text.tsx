import type { FindMatch } from "./index";

/** Split only syntax runs intersecting the selected match; retain token colors. */
export function findPaintedText(
  text: string,
  offset: number,
  match: FindMatch | null,
) {
  if (!match || match.to <= offset || match.from >= offset + text.length)
    return text;
  const from = Math.max(0, match.from - offset),
    to = Math.min(text.length, match.to - offset);
  return (
    <>
      {text.slice(0, from)}
      <mark className="cantrip-editor-find-match" data-find-active="true">
        {text.slice(from, to)}
      </mark>
      {text.slice(to)}
    </>
  );
}
