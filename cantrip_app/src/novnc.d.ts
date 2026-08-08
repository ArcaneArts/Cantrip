declare module "@novnc/novnc" {
  export interface RfbEventMap {
    clipboard: CustomEvent<{ text: string }>;
    connect: Event;
    credentialsrequired: CustomEvent<{ types: string[] }>;
    desktopname: CustomEvent<{ name: string }>;
    disconnect: CustomEvent<{ clean: boolean }>;
  }

  export default class RFB {
    constructor(
      target: HTMLElement,
      channel: unknown,
      options?: {
        credentials?: { password?: string; target?: string; username?: string };
        shared?: boolean;
      },
    );
    background: string;
    resizeSession: boolean;
    scaleViewport: boolean;
    viewOnly: boolean;
    addEventListener<K extends keyof RfbEventMap>(
      type: K,
      listener: (event: RfbEventMap[K]) => void,
    ): void;
    clipboardPasteFrom(text: string): void;
    disconnect(): void;
    focus(options?: FocusOptions): void;
    sendCtrlAltDel(): void;
  }
}
