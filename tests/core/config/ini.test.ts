import { describe, expect, it } from "vitest";
import { parseIni, stringifyIni } from "../../../src/core/config/ini.js";

describe("parseIni", () => {
  it("parses AWS-style sections and key-value pairs", () => {
    expect(
      parseIni(`
        # comment
        [default]
        profile = work

        [profile work]
        workspace = main
        user_email = quentin@example.com
      `)
    ).toEqual({
      default: { profile: "work" },
      "profile work": {
        workspace: "main",
        user_email: "quentin@example.com"
      }
    });
  });

  it("merges duplicate sections like common INI parsers", () => {
    expect(
      parseIni(`
        [profile work]
        workspace = main

        [profile work]
        workspace_id = 222
      `)
    ).toEqual({
      "profile work": {
        workspace: "main",
        workspace_id: "222"
      }
    });
  });

  it("fails on key-value pairs outside a section", () => {
    expect(() => parseIni("profile = work\n")).toThrow("key-value pair must be inside a section");
  });

  it("rejects object prototype pollution keys", () => {
    expect(() =>
      parseIni(`
        [__proto__]
        polluted = true
      `)
    ).toThrow("invalid section name");

    expect(() =>
      parseIni(`
        [default]
        constructor = true
      `)
    ).toThrow("invalid key");
  });

  it("returns null-prototype dictionaries", () => {
    const document = parseIni(`
      [default]
      profile = work
    `);

    expect(Object.getPrototypeOf(document)).toBeNull();
    expect(Object.getPrototypeOf(document.default)).toBeNull();
  });
});

describe("stringifyIni", () => {
  it("serializes section objects", () => {
    expect(
      stringifyIni({
        default: { profile: "work" },
        work: { type: "api_key", api_key: "lin_api_xxx" }
      })
    ).toBe("[default]\nprofile = work\n\n[work]\ntype = api_key\napi_key = lin_api_xxx\n");
  });

  it("rejects values containing newlines (INI injection)", () => {
    expect(() =>
      stringifyIni({
        work: { workspace: "acme\n[evil]\napi_key = stolen" }
      })
    ).toThrow(/must not contain newlines/);
  });

  it("rejects section names containing newlines or brackets", () => {
    expect(() => stringifyIni({ "a\nb": { k: "v" } })).toThrow(/must not contain newlines/);
    expect(() => stringifyIni({ "a]b": { k: "v" } })).toThrow(/must not contain brackets/);
  });

  it("rejects keys containing '=' or newlines", () => {
    expect(() => stringifyIni({ work: { "a=b": "v" } })).toThrow(/must not contain '='/);
    expect(() => stringifyIni({ work: { "a\nb": "v" } })).toThrow(/must not contain newlines/);
  });
});
