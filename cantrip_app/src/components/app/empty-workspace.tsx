export function EmptyWorkspace({
  projectName,
}: {
  projectName?: string | null;
}) {
  return (
    <div
      className="flex min-h-0 min-w-0 w-full flex-1 flex-col items-center justify-center gap-4 px-6 text-center"
      aria-label="Empty workspace"
    >
      <span
        aria-hidden="true"
        className="size-32 bg-foreground opacity-10"
        style={{ mask: "url(/favicon.svg) center / contain no-repeat" }}
      />
      {projectName ? (
        <p className="max-w-full break-words text-3xl font-semibold leading-tight text-foreground opacity-10 sm:text-4xl">
          {projectName}
        </p>
      ) : null}
    </div>
  );
}
