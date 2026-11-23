import { describe, expect, it } from "vitest";

import {
  TerminalCanonicalState,
  TERMINAL_CANONICAL_SNAPSHOT_MAX_CHARACTERS,
} from "../src/terminal-canonical-state.js";

async function writeInChunks(
  terminal: TerminalCanonicalState,
  data: string,
  chunkSize = 64 * 1_024,
): Promise<void> {
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    await terminal.write(data.slice(offset, offset + chunkSize));
  }
}

describe("TerminalCanonicalState", () => {
  it("round-trips an alternate-screen TUI with modes, color, and wide Unicode", async () => {
    const terminal = new TerminalCanonicalState(48, 12);
    const restored = new TerminalCanonicalState(48, 12);
    try {
      await terminal.write(
        "\x1b[?1049h\x1b[2J\x1b[?1h\x1b[?2004h" +
          "\x1b[1;1H\x1b[38;2;0;220;255mCANTRIP TUI\x1b[0m" +
          "\x1b[4;3Hwide: 界🙂" +
          "\x1b[11;1Hfooter: [q] quit" +
          "\x1b[7;9H",
      );

      const snapshot = terminal.snapshot();
      expect(snapshot).toMatchObject({
        activeBuffer: "alternate",
        cols: 48,
        cursor: { x: 8, y: 6 },
        rows: 12,
        modes: {
          applicationCursorKeysMode: true,
          bracketedPasteMode: true,
        },
      });
      expect(snapshot.data).toContain("CANTRIP TUI");
      expect(snapshot.data).toContain("wide: 界🙂");
      expect(snapshot.data).toContain("footer: [q] quit");

      await restored.write(snapshot.data);
      const roundTrip = restored.snapshot();
      expect(roundTrip).toMatchObject({
        activeBuffer: "alternate",
        cols: 48,
        cursor: { x: 8, y: 6 },
        rows: 12,
        modes: {
          applicationCursorKeysMode: true,
          bracketedPasteMode: true,
        },
      });
      expect(roundTrip.data).toContain("CANTRIP TUI");
      expect(roundTrip.data).toContain("wide: 界🙂");
      expect(roundTrip.data).toContain("footer: [q] quit");
    } finally {
      terminal.dispose();
      restored.dispose();
    }
  });

  it("retains the complete screen after more than two million characters of differential updates", async () => {
    const terminal = new TerminalCanonicalState(100, 24);
    try {
      const initialFrame =
        "\x1b[?1049h\x1b[2J" +
        "\x1b[1;1HFRAME HEADER — 界" +
        "\x1b[12;1Hcounter: 000000" +
        "\x1b[24;1HFRAME FOOTER";
      const updates: string[] = [];
      let emittedCharacters = initialFrame.length;
      let counter = 0;
      while (emittedCharacters <= 2_100_000) {
        const update = `\x1b[12;1Hcounter: ${String(counter).padStart(6, "0")}`;
        updates.push(update);
        emittedCharacters += update.length;
        counter += 1;
      }
      const differentialStream = `${initialFrame}${updates.join("")}`;
      const legacyTail = differentialStream.slice(-2_000_000);
      expect(differentialStream.length).toBeGreaterThan(2_000_000);
      expect(legacyTail).not.toContain("FRAME HEADER");
      expect(legacyTail).not.toContain("FRAME FOOTER");

      await writeInChunks(terminal, differentialStream);
      const snapshot = terminal.snapshot();
      expect(snapshot.activeBuffer).toBe("alternate");
      expect(snapshot.data).toContain("FRAME HEADER — 界");
      expect(snapshot.data).toContain("FRAME FOOTER");
      expect(snapshot.data).toContain(
        `counter: ${String(counter - 1).padStart(6, "0")}`,
      );
      expect(snapshot.data.length).toBeLessThan(20_000);
    } finally {
      terminal.dispose();
    }
  });

  it("resets state between process generations", async () => {
    const terminal = new TerminalCanonicalState(80, 24);
    try {
      await terminal.write("\x1b[?1049h\x1b[2JOLD GENERATION");
      terminal.resize(132, 43);
      terminal.reset(132, 43);
      await terminal.write("NEW GENERATION");

      const snapshot = terminal.snapshot();
      expect(snapshot).toMatchObject({
        activeBuffer: "normal",
        cols: 132,
        generation: 1,
        rows: 43,
      });
      expect(snapshot.data).toContain("NEW GENERATION");
      expect(snapshot.data).not.toContain("OLD GENERATION");
    } finally {
      terminal.dispose();
    }
  });

  it("continues an in-flight synchronized update across snapshot hydration", async () => {
    const terminal = new TerminalCanonicalState(60, 16);
    const restored = new TerminalCanonicalState(60, 16);
    try {
      await terminal.write(
        "\x1b[?1049h\x1b[2J" +
          "\x1b[1;1HSTATIC HEADER" +
          "\x1b[16;1HSTATIC FOOTER" +
          "\x1b[?2026h\x1b[8;1Hdynamic: 41",
      );
      const snapshot = terminal.snapshot();
      expect(snapshot.modes.synchronizedOutputMode).toBe(true);

      await restored.write(snapshot.data);
      await restored.write("\x1b[8;1Hdynamic: 42\x1b[?2026l");
      const completed = restored.snapshot();
      expect(completed.modes.synchronizedOutputMode).toBe(false);
      expect(completed.data).toContain("STATIC HEADER");
      expect(completed.data).toContain("STATIC FOOTER");
      expect(completed.data).toContain("dynamic: 42");
    } finally {
      terminal.dispose();
      restored.dispose();
    }
  });

  it("bounds serialized normal-buffer scrollback", async () => {
    const terminal = new TerminalCanonicalState(400, 24);
    try {
      const lines = Array.from(
        { length: 6_000 },
        (_, index) => `${String(index).padStart(6, "0")}:${"x".repeat(390)}`,
      ).join("\r\n");
      await writeInChunks(terminal, lines);

      const snapshot = terminal.snapshot();
      expect(snapshot.data.length).toBeLessThanOrEqual(
        TERMINAL_CANONICAL_SNAPSHOT_MAX_CHARACTERS,
      );
      expect(snapshot.scrollbackRows).toBeLessThan(6_000);
      expect(snapshot.data).toContain("005999:");
    } finally {
      terminal.dispose();
    }
  });
});
