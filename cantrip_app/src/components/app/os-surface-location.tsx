import { useQuery } from "@tanstack/react-query";
import { getCantripOsBindings } from "@/lib/api/cantrip-os";

/** Captured Linux resources never display a worker-local fallback location. */
export function OsSurfaceLocation({
  projectId,
  bindingId,
  runtimeGeneration,
}: {
  projectId: string | undefined;
  bindingId: string;
  runtimeGeneration?: string;
}) {
  const bindings = useQuery({
    queryKey: ["cantrip-os-bindings", projectId],
    queryFn: () => getCantripOsBindings(projectId!),
    enabled: Boolean(projectId),
  });
  const binding = bindings.data?.find((item) => item.id === bindingId);
  return (
    <>
      CantripOS
      {binding ? ` · ${binding.guestPath}` : " · captured Linux target"}
      {binding?.provisionedRuntimeGeneration &&
      runtimeGeneration &&
      binding.provisionedRuntimeGeneration !== runtimeGeneration
        ? " · previous runtime"
        : null}
    </>
  );
}
