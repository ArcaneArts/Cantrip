type FocusableChatComposer = {
  disabled: boolean;
  focus(options?: FocusOptions): void;
};

export function scheduleChatComposerFocus(
  getComposer: () => FocusableChatComposer | null,
  schedule: (callback: FrameRequestCallback) => number,
): void {
  schedule(() => {
    const composer = getComposer();
    if (!composer || composer.disabled) return;
    composer.focus({ preventScroll: true });
  });
}
