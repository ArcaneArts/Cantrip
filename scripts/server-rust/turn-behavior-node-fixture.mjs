import {
  ModelBehaviorTracker,
  isObservedTestCommand,
} from "../../cantrip_server/src/analytics/model-behavior.ts";
export function makeTurnBehaviorTracker(input) {
  const tracker = new ModelBehaviorTracker(),
    snapshots = [];
  for (const action of input.actions ?? []) {
    const at = new Date(action.at ?? "2026-10-25T00:00:00.123Z");
    switch (action.kind) {
      case "activity":
        tracker.observeActivity(action.value, at);
        break;
      case "usage":
        tracker.observeUsage(action.value, at);
        break;
      case "visible":
        tracker.markVisibleResponse(action.final, at);
        break;
      case "approval":
        tracker.markApproval(action.key, at);
        break;
      case "mark":
        tracker.markActivity(at);
        break;
      case "native-event":
        tracker.observeNativeEvent(action.value);
        break;
      case "native-turn":
        tracker.observeNativeTurn(action.turn, action.capture);
        break;
      case "mutate-snapshot":
        snapshots.at(-1).nativeAttribution.captures.length = 0;
        break;
      default:
        throw new Error("Unknown behavior fixture action");
    }
    snapshots.push(tracker.snapshot());
  }
  return { tracker, snapshots };
}
export function turnBehaviorFixture(input) {
  const { tracker, snapshots } = makeTurnBehaviorTracker(input);
  return {
    snapshots,
    snapshot: tracker.snapshot(),
    tests: (input.commands ?? []).map(isObservedTestCommand),
  };
}
