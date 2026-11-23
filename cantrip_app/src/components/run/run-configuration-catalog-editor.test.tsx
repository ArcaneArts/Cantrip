// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import type { RunConfigurationCatalog } from "@/lib/run-configuration-catalog";
import { runConfigurationCatalogKey } from "@/lib/run-configuration-catalog";
import { RunConfigurationCatalogEditor } from "./run-configuration-catalog-editor";
import { RunSourceControl } from "./run-source-control";
import { TooltipProvider } from "@/components/ui/tooltip";
vi.mock("./run-configuration-editor", async () => {
  const { useRunDefinitionScope } = await import("@/lib/run-definition-source");
  return {
    RunConfigurationEditor: ({
      destinationLabel,
    }: {
      destinationLabel?: string;
    }) => (
      <output data-scope={useRunDefinitionScope()}>
        {destinationLabel ?? "Host editor"}
      </output>
    ),
  };
});
const id = "00000000-0000-4000-8000-000000000001";
const binding = {
  id,
  bindingGeneration: id,
  provisionedAttachmentGeneration: id,
  provisionedRuntimeGeneration: id,
} as NonNullable<RunConfigurationCatalog["binding"]>;
const host: RunConfigurationCatalog = {
  key: "host",
  label: "Host",
  available: true,
  inventory: null,
  runtimes: [],
  worktrees: [],
};
const linux: RunConfigurationCatalog = {
  ...host,
  key: "linux-source",
  label: "CantripOS / work",
  binding,
};
const mount = document.createElement("div");
document.body.append(mount);
let root = createRoot(mount);
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(async () => {
  await act(async () => root.unmount());
  root = createRoot(mount);
});
async function render(catalogs: RunConfigurationCatalog[], key = "new") {
  await act(async () =>
    root.render(
      <RunConfigurationCatalogEditor
        catalogs={catalogs}
        configurationKey={key}
        projectId="project"
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    ),
  );
}
it("skips destination selection when only Host exists", async () => {
  await render([host]);
  expect(mount.textContent).toBe("Host editor");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
it("chooses the destination for a new config without changing a global source", async () => {
  await render([host, linux]);
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain("Choose where this configuration");
  const choose = [...dialog.querySelectorAll("button")].find(
    (button) => button.textContent === linux.label,
  )!;
  await act(async () => choose.click());
  expect(mount.querySelector("output")?.textContent).toBe(linux.label);
  expect(mount.querySelector("output")?.getAttribute("data-scope")).toContain(
    binding.id,
  );
});
it("edits the config's own destination even when Host has the same configuration ID", async () => {
  await render([host, linux], runConfigurationCatalogKey(linux.key, id));
  expect(mount.querySelector("output")?.textContent).toBe(linux.label);
});
it("shows no source switch for a Host-only project", () => {
  const client = new QueryClient();
  client.setQueryData(["cantrip-os-run-sources", "project"], []);
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <RunSourceControl
          projectId="project"
          editorConfigurationId={null}
          inventory={{
            directory: ".cantrip/run-configurations",
            diagnostics: [],
            entries: [],
            validations: [],
          }}
          loading={false}
          runtimes={[]}
          workers={[]}
          worktrees={[]}
          onEditorConfigurationChange={vi.fn()}
          onFocusTerminal={vi.fn()}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  expect(html).toContain("Run Configurations");
  expect(html).not.toContain('aria-label="Run source"');
  expect(html).not.toContain("<select");
});
