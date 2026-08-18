import type { WorkflowDefinitionDetail } from "@cantrip/protocol/workflows";
import { describe, expect, it } from "vitest";

import {
  availableWorkflowAutomationTypes,
  canWorkflowUseUnattendedTriggers,
  sha256Hex,
} from "./workflow-automation-dialog";

function workflow(): WorkflowDefinitionDetail {
  return {
    workflow: { trustState: "trusted" },
    revision: {
      trustState: "trusted",
      permissionRequirements: { approvalMode: "preauthorized" },
      nodes: [{ permissionRequirements: { approvalMode: "preauthorized" } }],
    },
  } as unknown as WorkflowDefinitionDetail;
}

describe("workflow automation authoring", () => {
  it("does not offer Git events for direct folder workflows", () => {
    expect(availableWorkflowAutomationTypes(false)).toEqual([
      "schedule",
      "api",
      "webhook",
      "saved-command",
    ]);
    expect(availableWorkflowAutomationTypes(true)).toContain("git");
  });

  it("requires trusted, fully preauthorized workflow state", () => {
    const allowed = workflow();
    expect(canWorkflowUseUnattendedTriggers(allowed)).toBe(true);

    const modified = workflow();
    modified.workflow.trustState = "modified";
    expect(canWorkflowUseUnattendedTriggers(modified)).toBe(false);

    const prompting = workflow();
    prompting.revision!.nodes[0]!.permissionRequirements.approvalMode =
      "interactive";
    expect(canWorkflowUseUnattendedTriggers(prompting)).toBe(false);
  });

  it("hashes webhook credentials before transport", async () => {
    const credential = "local-webhook-credential";
    await expect(sha256Hex(credential)).resolves.toBe(
      "522f59afc49be66aa2d30edcfc3237d907cbcfa6f4880553aa2b6d75b71958e7",
    );
  });
});
