import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function discoverCodexVersion(
  binary: string,
): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync(binary, ["--version"], {
      timeout: 5_000,
    });
    const version = `${stdout}${stderr}`.trim();
    return version.length > 0 ? version : null;
  } catch {
    return null;
  }
}
