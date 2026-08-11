import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  projectAutomationConditionResultSchema,
  type ProjectAutomationCondition,
  type ProjectAutomationConditionResult,
} from "@cantrip/protocol/automations";

const execFileAsync = promisify(execFile);

export interface ProjectAutomationConditionDependencies {
  countOpenIssues(repository: string): Promise<number>;
  runScript?(script: string, cwd: string): Promise<number>;
}

export async function runProjectAutomationConditionScript(
  script: string,
  cwd: string,
): Promise<number> {
  const command = process.platform === "win32" ? "powershell.exe" : "/bin/sh";
  const args =
    process.platform === "win32"
      ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script]
      : ["-lc", script];
  try {
    await execFileAsync(command, args, {
      cwd,
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
      windowsHide: true,
    });
    return 0;
  } catch (error) {
    const failure = error as {
      code?: number | string;
      killed?: boolean;
      signal?: string;
    };
    if (!failure.killed && !failure.signal) {
      const exitCode = Number(failure.code);
      if (Number.isInteger(exitCode) && exitCode !== 0) return exitCode;
    }
    throw error;
  }
}

export async function evaluateProjectAutomationCondition(
  condition: ProjectAutomationCondition,
  cwd: string,
  repository: string | null,
  dependencies: ProjectAutomationConditionDependencies,
): Promise<ProjectAutomationConditionResult> {
  if (condition.type === "script") {
    const exitCode = await (
      dependencies.runScript ?? runProjectAutomationConditionScript
    )(condition.script, cwd);
    return projectAutomationConditionResultSchema.parse({
      allowed: exitCode === 0,
      detail:
        exitCode === 0
          ? "Condition script exited with code 0."
          : `Condition script exited with code ${exitCode}.`,
    });
  }

  if (!repository) {
    throw new Error(
      "Open-issue conditions require a GitHub-backed project repository.",
    );
  }
  const count = await dependencies.countOpenIssues(repository);
  return projectAutomationConditionResultSchema.parse({
    allowed: count >= condition.minimum,
    detail: `${count} open ${count === 1 ? "issue" : "issues"}; ${condition.minimum} required.`,
  });
}
