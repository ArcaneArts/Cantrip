import type { CuaActivity } from "../src/computer-use/activity.js";
import { expect } from "vitest";
import type { createNativeCuaWorkerFixture } from "./native-cua-worker-fixture.js";

// Opt-in wall-clock acceptance: run the normal GUI/terminal CUA cases with the
// Cargo timed_input_fixture example as CANTRIP_CUA_TEST_BINARY. This is not a
// production limit or a substitute for a real macOS duet/input test.
export const nativeCuaTimelineMs =
  process.env.CANTRIP_CUA_LONG_TIMELINE_TEST === "1" ? 150_000 : 0;

export function nativeCuaScript(index: number): string {
  const playback =
    index === 1 && nativeCuaTimelineMs
      ? `const timeline = await cua.clickSequence([{atMs:0,x:20,y:30},{atMs:${nativeCuaTimelineMs - 25},x:40,y:50}], {holdMs:25});`
      : "";
  return `await cua.attach({targetId:'fake-window',targetGeneration:1});
    await cua.moveCursor({x:20,y:30}); ${playback} await cua.snapshot();
    ${index === 4 ? "for (let i=0;i<15;i++) await cua.wait(10000);" : ""}
    ${playback ? `({marker:'cua-native-${index}',timeline})` : `'cua-native-${index}'`}`;
}

export function assertCompletedNativeCuaTimeline(
  call: Awaited<
    ReturnType<typeof createNativeCuaWorkerFixture>
  >["calls"][number],
  activities: CuaActivity[],
) {
  expect(call.elapsedMs).toBeGreaterThanOrEqual(nativeCuaTimelineMs);
  const output = JSON.stringify(
    call.result?.content.filter((item) => item.type === "text"),
  );
  const input = activities.filter(
    (activity) =>
      activity.operation === "input.perform" &&
      activity.binding.turnId === call.args[1].turnId,
  );
  expect(input).toHaveLength(1);
  expect(input[0]).toMatchObject({
    outcome: "completed",
    input: {
      method: "background-timeline",
      outcome: "dispatched",
      position: { x: 40, y: 50 },
    },
  });
  expect(
    input[0]!.completedAtMs! - input[0]!.startedAtMs,
  ).toBeGreaterThanOrEqual(nativeCuaTimelineMs);
  const snapshot = activities.find(
    (activity) =>
      activity.operation === "observation.snapshot" &&
      activity.binding.turnId === call.args[1].turnId,
  );
  expect(snapshot?.startedAtMs).toBeGreaterThanOrEqual(
    input[0]!.completedAtMs!,
  );
  expect(output).toContain("cua-native-1");
}
