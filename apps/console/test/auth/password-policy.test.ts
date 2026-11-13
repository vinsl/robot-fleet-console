import { describe, expect, it } from "vitest";
import {
  checkPassword,
  meetsPolicy,
  PASSWORD_MIN_LENGTH,
  PASSWORD_RULES,
} from "../../src/auth/password-policy";

describe("password policy", () => {
  it("accepts a password that satisfies every rule", () => {
    expect(meetsPolicy(checkPassword("Correct-horse-42"))).toBe(true);
  });

  it("reports the rules one by one", () => {
    expect(checkPassword("abc")).toEqual({
      length: false,
      lowercase: true,
      uppercase: false,
      number: false,
      symbol: false,
    });
  });

  it("counts the length at the minimum, not below it", () => {
    const at = "Aa1!".padEnd(PASSWORD_MIN_LENGTH, "x");
    expect(checkPassword(at).length).toBe(true);
    expect(checkPassword(at.slice(0, -1)).length).toBe(false);
  });

  it.each([
    "^",
    "$",
    "*",
    ".",
    "[",
    "]",
    "{",
    "}",
    "(",
    ")",
    "?",
    "-",
    '"',
    "!",
    "@",
    "#",
    "%",
    "&",
    "/",
    "\\",
    ",",
    ">",
    "<",
    "'",
    ":",
    ";",
    "|",
    "_",
    "~",
    "`",
    "+",
    "=",
  ])("counts %s as a special character", (symbol) => {
    expect(checkPassword(`x${symbol}`).symbol).toBe(true);
  });

  it("does not count a space or a letter with an accent as a special character", () => {
    expect(checkPassword("a b").symbol).toBe(false);
    expect(checkPassword("é").symbol).toBe(false);
  });

  it("fails the whole policy when one rule is missing", () => {
    for (const rule of PASSWORD_RULES) {
      const check = { ...checkPassword("Correct-horse-42"), [rule]: false };
      expect(meetsPolicy(check)).toBe(false);
    }
  });
});
