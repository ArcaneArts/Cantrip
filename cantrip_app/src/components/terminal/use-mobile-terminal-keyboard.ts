import { isTauri } from "@tauri-apps/api/core";
import type { RefObject } from "react";
import { useEffect, useRef, useState } from "react";

export const MOBILE_TERMINAL_COMMAND_BAR_HEIGHT_PX = 48;
export const MOBILE_KEYBOARD_HEIGHT_THRESHOLD_PX = 120;
const VIEWPORT_WIDTH_RESET_THRESHOLD_PX = 48;
const MOBILE_INPUT_MEDIA_QUERY =
  "(max-width: 767px), (hover: none) and (pointer: coarse)";

export interface MobileTerminalViewportSample {
  baselineHeight: number;
  baselineWidth: number;
  innerHeight: number;
  viewportHeight: number;
  viewportOffsetTop: number;
  viewportWidth: number;
}

export interface MobileTerminalViewportMeasurement {
  bottomInset: number;
  keyboardOpen: boolean;
  nextBaselineHeight: number;
  nextBaselineWidth: number;
  visibleBottom: number;
}

export function measureMobileTerminalViewport({
  baselineHeight,
  baselineWidth,
  innerHeight,
  viewportHeight,
  viewportOffsetTop,
  viewportWidth,
}: MobileTerminalViewportSample): MobileTerminalViewportMeasurement {
  const height = Math.max(0, viewportHeight);
  const width = Math.max(0, viewportWidth);
  const visibleBottom = Math.min(
    innerHeight,
    Math.max(0, viewportOffsetTop + height),
  );
  const bottomInset = Math.max(0, innerHeight - visibleBottom);

  if (Math.abs(width - baselineWidth) >= VIEWPORT_WIDTH_RESET_THRESHOLD_PX) {
    return {
      bottomInset: 0,
      keyboardOpen: false,
      nextBaselineHeight: height,
      nextBaselineWidth: width,
      visibleBottom,
    };
  }

  const lostHeight = Math.max(0, baselineHeight - height);
  const keyboardOpen =
    Math.max(lostHeight, bottomInset) >= MOBILE_KEYBOARD_HEIGHT_THRESHOLD_PX;

  return {
    bottomInset: keyboardOpen ? bottomInset : 0,
    keyboardOpen,
    nextBaselineHeight: keyboardOpen
      ? baselineHeight
      : Math.max(baselineHeight, height),
    nextBaselineWidth: width,
    visibleBottom,
  };
}

export interface MobileTerminalKeyboardState {
  bottomInset: number;
  contentInset: number;
  open: boolean;
}

const CLOSED_KEYBOARD_STATE: MobileTerminalKeyboardState = {
  bottomInset: 0,
  contentInset: 0,
  open: false,
};

function statesMatch(
  left: MobileTerminalKeyboardState,
  right: MobileTerminalKeyboardState,
) {
  return (
    left.bottomInset === right.bottomInset &&
    left.contentInset === right.contentInset &&
    left.open === right.open
  );
}

function useMobileInputLayout() {
  const [mobileInput, setMobileInput] = useState(
    () => window.matchMedia(MOBILE_INPUT_MEDIA_QUERY).matches && !isTauri(),
  );

  useEffect(() => {
    const media = window.matchMedia(MOBILE_INPUT_MEDIA_QUERY);
    const update = () => setMobileInput(media.matches && !isTauri());
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return mobileInput;
}

export function useMobileTerminalKeyboard(
  terminalSurfaceRef: RefObject<HTMLElement | null>,
): MobileTerminalKeyboardState {
  const mobileInputLayout = useMobileInputLayout();
  const baselineRef = useRef<{ height: number; width: number } | null>(null);
  const [state, setState] = useState(CLOSED_KEYBOARD_STATE);

  useEffect(() => {
    if (!mobileInputLayout) {
      baselineRef.current = null;
      setState(CLOSED_KEYBOARD_STATE);
      return;
    }

    let animationFrame: number | null = null;
    const visualViewport = window.visualViewport;

    const update = () => {
      animationFrame = null;
      const viewportHeight = visualViewport?.height ?? window.innerHeight;
      const viewportWidth = visualViewport?.width ?? window.innerWidth;
      const baseline = baselineRef.current ?? {
        height: viewportHeight,
        width: viewportWidth,
      };
      const measurement = measureMobileTerminalViewport({
        baselineHeight: baseline.height,
        baselineWidth: baseline.width,
        innerHeight: window.innerHeight,
        viewportHeight,
        viewportOffsetTop: visualViewport?.offsetTop ?? 0,
        viewportWidth,
      });
      baselineRef.current = {
        height: measurement.nextBaselineHeight,
        width: measurement.nextBaselineWidth,
      };

      const barTop =
        measurement.visibleBottom - MOBILE_TERMINAL_COMMAND_BAR_HEIGHT_PX;
      const surfaceBottom =
        terminalSurfaceRef.current?.getBoundingClientRect().bottom ??
        measurement.visibleBottom;
      const nextState = measurement.keyboardOpen
        ? {
            bottomInset: measurement.bottomInset,
            contentInset: Math.max(0, surfaceBottom - barTop),
            open: true,
          }
        : CLOSED_KEYBOARD_STATE;
      setState((current) =>
        statesMatch(current, nextState) ? current : nextState,
      );
    };

    const scheduleUpdate = () => {
      if (animationFrame !== null) cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(update);
    };

    update();
    window.addEventListener("resize", scheduleUpdate);
    visualViewport?.addEventListener("resize", scheduleUpdate);
    visualViewport?.addEventListener("scroll", scheduleUpdate);
    return () => {
      if (animationFrame !== null) cancelAnimationFrame(animationFrame);
      window.removeEventListener("resize", scheduleUpdate);
      visualViewport?.removeEventListener("resize", scheduleUpdate);
      visualViewport?.removeEventListener("scroll", scheduleUpdate);
    };
  }, [mobileInputLayout, terminalSurfaceRef]);

  return state;
}
