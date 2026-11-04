import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { TerminalSummary } from "@cantrip/protocol";
import type { RunConfigurationRuntime } from "@cantrip/protocol/run-configuration-runtime";
import { CapturedRunTerminalView } from "./captured-run-terminal-view";

vi.mock("./run-terminal-view", () => ({
  RunTerminalView: (props: {
    launchAvailable: boolean;
    stopAvailable: boolean;
    runtime: RunConfigurationRuntime | null;
    targetLabel: string;
    onEdit?: () => void;
  }) => (
    <output
      data-launch={String(props.launchAvailable)}
      data-stop={String(props.stopAvailable)}
      data-runtime={props.runtime?.id ?? "none"}
      data-edit={Boolean(props.onEdit)}
    >
      {props.targetLabel}
    </output>
  ),
}));
const id = "12345678-1234-4234-8234-123456789abc";
const terminal = {
  id,
  projectId: id,
  worktreeId: id,
  runConfigurationId: id,
  runConfigurationRuntimeId: id,
  kind: "run-configuration",
  title: "Run",
} as TerminalSummary;
function render(runtime?: RunConfigurationRuntime) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  if (runtime)
    client.setQueryData(["run-configuration-runtime", id, id], [runtime]);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <CapturedRunTerminalView
        terminal={terminal}
        runtime={null}
        definitionAvailable={true}
        launchAvailable={true}
        stopAvailable={true}
        targetLabel="Host Primary"
        onEdit={() => {}}
      />
    </QueryClientProvider>,
  );
}
describe("captured Run terminal identity", () => {
  it("cannot start or edit a Host target while its captured runtime is unresolved", () => {
    const html = render();
    expect(html).toContain('data-launch="false"');
    expect(html).toContain('data-stop="false"');
    expect(html).toContain('data-edit="false"');
  });
  it("keeps a stale Linux runtime in Linux and offers its explicit Stop without a Host edit action", () => {
    const html = render({
      id,
      osDefinition: {
        kind: "binding",
        bindingId: id,
        bindingGeneration: id,
        attachmentGeneration: id,
        runtimeGeneration: id,
      },
      osTargetGuestPath: "/linux/old-target",
    } as RunConfigurationRuntime);
    expect(html).toContain("Linux · /linux/old-target");
    expect(html).toContain('data-launch="false"');
    expect(html).toContain('data-stop="true"');
    expect(html).toContain('data-edit="false"');
  });
  it("retains ordinary Host controls after loading their exact runtime ID", () => {
    const html = render({ id } as RunConfigurationRuntime);
    expect(html).toContain('data-launch="true"');
    expect(html).toContain('data-edit="true"');
  });
});
