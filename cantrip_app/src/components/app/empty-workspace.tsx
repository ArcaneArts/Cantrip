export function EmptyWorkspace() {
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 items-center justify-center"
      aria-label="Empty workspace"
    >
      <span
        aria-hidden="true"
        className="size-32 bg-foreground opacity-10"
        style={{ mask: "url(/favicon.svg) center / contain no-repeat" }}
      />
    </div>
  );
}
