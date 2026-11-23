import "./cantrip-loading.css";

export function CantripLoading({
  label = "Loading Cantrip…",
}: {
  label?: string;
}) {
  return (
    <div
      role="status"
      aria-label={label}
      className="grid min-h-0 min-w-0 w-full flex-1 place-items-center p-6"
      data-cantrip-loading=""
    >
      <span aria-hidden="true" className="cantrip-loading__mark">
        <span className="cantrip-loading__shimmer" />
      </span>
    </div>
  );
}
