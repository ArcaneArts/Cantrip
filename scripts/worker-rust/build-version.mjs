// Build-time only; use the repository's existing authoritative version resolver.
import { resolveCantripVersion } from "../version.mjs";
process.stdout.write(JSON.stringify(resolveCantripVersion()));
