import { Haptics, ImpactStyle, type ImpactOptions } from "@capacitor/haptics";

export type MobileNavigationHaptic = "press" | "reset";

type HapticImpact = (options: ImpactOptions) => Promise<void>;

function fallbackVibration(kind: MobileNavigationHaptic): void {
  if (
    typeof navigator === "undefined" ||
    typeof navigator.vibrate !== "function"
  ) {
    return;
  }
  navigator.vibrate(kind === "press" ? 10 : 25);
}

export async function performMobileNavigationHaptic(
  kind: MobileNavigationHaptic,
  impact: HapticImpact = (options) => Haptics.impact(options),
): Promise<void> {
  try {
    await impact({
      style: kind === "press" ? ImpactStyle.Light : ImpactStyle.Medium,
    });
  } catch {
    fallbackVibration(kind);
  }
}
