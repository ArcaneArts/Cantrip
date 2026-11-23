import { setTimeout as delay } from "node:timers/promises";

const commit = process.argv[2];
if (!/^[0-9a-f]{40}$/u.test(commit ?? "")) {
  throw new Error("Expected a full release commit.");
}

async function waitForCommit(origin) {
  const url = new URL("/release.json", origin);
  url.searchParams.set("commit", commit);
  const deadline = Date.now() + 15 * 60 * 1000;
  let observed = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        redirect: "error",
        signal: AbortSignal.timeout(8_000),
      });
      if (
        response.ok &&
        response.headers.get("content-type")?.includes("application/json")
      ) {
        const release = await response.json();
        if (release.commit === commit) {
          console.log(`${origin} is serving release ${commit.slice(0, 12)}.`);
          return;
        }
        observed = String(release.commit ?? "missing revision");
      } else {
        observed = `HTTP ${response.status} without a release marker`;
      }
    } catch (error) {
      observed = error.message;
    }
    await delay(15_000);
  }
  throw new Error(
    `${origin} did not serve release ${commit} (last observation: ${observed}).`,
  );
}

await Promise.all(
  ["https://cantrip.art", "https://app.cantrip.art"].map(waitForCommit),
);
