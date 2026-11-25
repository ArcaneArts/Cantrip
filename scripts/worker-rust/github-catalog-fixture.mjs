// Owned, network-free gh process boundary shared by native compatibility and
// real worker/server acceptance. The worker PATH contains no Node executable.
import { mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
export const catalogRepository = {
  id: 123,
  name: "cantrip-labs",
  full_name: "ArcaneArts/cantrip-labs",
  description: "A fixture 😀",
  private: true,
  fork: false,
  html_url: "https://github.com/ArcaneArts/cantrip-labs",
  default_branch: "main",
  updated_at: "2026-11-17T00:00:00Z",
};
export async function githubCatalogFixture(root, bin) {
  const directory = path.join(root, "github-cli-fixture");
  await mkdir(path.join(directory, "calls"), { recursive: true });
  await mkdir(bin, { recursive: true });
  const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  await writeFile(
    path.join(bin, "gh"),
    `#!/bin/sh
fixture=${quote(directory)}
printf '%s\\0' "$@" > "$fixture/calls/$$"
case "$1:$2:$6" in
  --version::) operation=version ;;
  api:user:*) operation=auth ;;
  api:--method:user/repos) operation=repositories ;;
  api:--method:user/orgs) operation=owners ;;
  repo:create:*) operation=create ;;
  api:repos/*:*) operation=repository ;;
  *) printf 'Unexpected owned gh invocation' >&2; exit 91 ;;
esac
/bin/cat "$fixture/$operation.stdout"
/bin/cat "$fixture/$operation.stderr" >&2
exit "$(/bin/cat "$fixture/$operation.status")"
`,
    { mode: 0o700 },
  );
  async function response(
    operation,
    value,
    { raw = false, stderr = "", status = 0 } = {},
  ) {
    await Promise.all([
      writeFile(
        path.join(directory, `${operation}.stdout`),
        raw ? value : JSON.stringify(value),
      ),
      writeFile(path.join(directory, `${operation}.stderr`), stderr),
      writeFile(path.join(directory, `${operation}.status`), String(status)),
    ]);
  }
  await response("version", "gh version 2.105.0\n", { raw: true });
  await response("auth", "fixture-user\n", { raw: true });
  await response("repositories", [[catalogRepository]]);
  await response("owners", [[{ login: "ArcaneArts" }]]);
  await response("create", "", { raw: true });
  await response("repository", catalogRepository);
  async function calls() {
    const entries = await readdir(path.join(directory, "calls"));
    const values = await Promise.all(
      entries.map(async (entry) => {
        const file = path.join(directory, "calls", entry);
        const value = (await readFile(file, "utf8")).split("\0").slice(0, -1);
        await rm(file);
        return value;
      }),
    );
    // Process identifiers are not ordered across implementations. Invocation
    // multiplicities and exact argv are compared; method sequencing is tested
    // separately by the real worker/server fixture.
    return values.sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
  }
  return { response, calls, directory };
}
