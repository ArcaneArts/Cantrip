export function hasScrolledContent(target: unknown): boolean {
  return (
    typeof target === "object" &&
    target !== null &&
    "scrollTop" in target &&
    typeof target.scrollTop === "number" &&
    target.scrollTop > 1
  );
}
