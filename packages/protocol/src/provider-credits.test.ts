import { describe, expect, it } from "vitest";
import { providerCreditBalance, shouldUseChatGptCredits } from "./providers.js";

describe("ChatGPT credit balance policy", () => {
  it.each([
    ["0", false],
    ["99.99", false],
    ["100", false],
    ["100.00", false],
    ["100.01", true],
    ["2500", true],
    [null, false],
    ["", false],
    ["invalid", false],
    ["Infinity", false],
    ["-200", false],
  ])("uses credits for balance %s only above 100", (balance, expected) => {
    expect(
      shouldUseChatGptCredits({ hasCredits: true, unlimited: false, balance }),
    ).toBe(expected);
  });
  it("keeps missing balances unknown and respects credit availability", () => {
    expect(providerCreditBalance(null)).toBeNull();
    expect(
      providerCreditBalance({
        hasCredits: true,
        unlimited: false,
        balance: " 1234.56 ",
      }),
    ).toBe(1234.56);
    expect(
      shouldUseChatGptCredits({
        hasCredits: false,
        unlimited: false,
        balance: "200",
      }),
    ).toBe(false);
    expect(
      shouldUseChatGptCredits({
        hasCredits: true,
        unlimited: true,
        balance: null,
      }),
    ).toBe(true);
  });
});
