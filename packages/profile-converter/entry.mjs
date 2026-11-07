// Bounded offline conversion only. The native preparation process supervises
// this CLI through its Rust parent-death owner; no JavaScript helper serves.
import path from "node:path";
import {
  exportLegacyProfile,
  restoreLegacyProfile,
} from "./legacy-profile.mjs";
const args = process.argv.slice(2);
try {
  const restore = args[0] === "--restore";
  if (restore) args.shift();
  const [source, output, executable, ...extra] = args;
  if (!source || !output || !executable || extra.length) {
    throw new Error(
      "Usage: profile-converter [--restore] <stopped source> <new destination> <native server>",
    );
  }
  const receipt = await (restore ? restoreLegacyProfile : exportLegacyProfile)({
    source: path.resolve(source),
    output: path.resolve(output),
    executable: path.resolve(executable),
  });
  console.log(JSON.stringify(receipt));
} catch {
  // SQL errors can contain private values. Only this bounded phase is public.
  console.error(
    "Legacy profile conversion failed; the active profile was retained.",
  );
  process.exitCode = 1;
}
