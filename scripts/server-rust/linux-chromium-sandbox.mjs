// Ubuntu's runner restricts user namespaces for downloaded Chromium binaries.
// Apply Chromium's documented per-executable AppArmor policy in ephemeral CI:
// https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md
// The worker's production command and Chromium sandbox remain unchanged.
import { execFileSync } from "node:child_process";
import { chromium } from "playwright-core";

const executable = chromium.executablePath();
const quotedPath =
  '"' + executable.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';
const profilePath = "/etc/apparmor.d/cantrip-ci-chromium";
const profile = `abi <abi/4.0>,
include <tunables/global>
profile cantrip-ci-chromium ${quotedPath} flags=(unconfined) {
  userns,
}
`;
execFileSync("sudo", ["tee", profilePath], {
  input: profile,
  stdio: ["pipe", "ignore", "inherit"],
});
execFileSync("sudo", ["apparmor_parser", "--replace", profilePath], {
  stdio: "inherit",
});
console.log(
  JSON.stringify({
    event: "ci.chromium.namespace-profile-loaded",
    executable,
    profilePath,
  }),
);
