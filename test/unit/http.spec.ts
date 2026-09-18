import { describe, expect, it } from "vitest";

import { normalizePublicUrl } from "../../src/utils/http.js";

describe("PUBLIC_URL configuration", () => {
  it.each([undefined, "", " \t\n "])("treats %j as unset", (value) => {
    expect(normalizePublicUrl(value)).toBeUndefined();
  });

  it.each([
    ["https://reports.example.com", "https://reports.example.com"],
    [" https://Reports.Example.com/ ", "https://reports.example.com"],
    ["https://reports.example.com:8443/", "https://reports.example.com:8443"],
    ["https://reports.example.com:443/", "https://reports.example.com"],
    ["http://localhost:3000/", "http://localhost:3000"],
    ["http://[::1]:3000/", "http://[::1]:3000"],
  ])("normalizes %j to an origin", (value, expected) => {
    expect(normalizePublicUrl(value)).toBe(expected);
  });

  it.each([
    "not a URL",
    "/reports",
    "//reports.example.com",
    "https:reports.example.com",
    "https:/reports.example.com",
    "https://",
    "https://reports.example.com:invalid",
    "ftp://reports.example.com",
    "javascript:alert(1)",
    "https://user:password@reports.example.com",
    "https://user@reports.example.com",
    "https://@reports.example.com",
    "https:///reports.example.com",
    "https://reports.example.com\\",
    "https://reports.\nexample.com",
    "https://reports.example.com/allure",
    "https://reports.example.com/allure/..",
    "https://reports.example.com/%2e",
    "https://reports.example.com/api/token",
    "https://reports.example.com/?foo=bar",
    "https://reports.example.com/?",
    "https://reports.example.com/#fragment",
    "https://reports.example.com/#",
  ])("rejects %j instead of silently changing it or falling back", (value) => {
    expect(() => normalizePublicUrl(value)).toThrow(
      "PUBLIC_URL must be an absolute HTTP(S) origin without credentials, a path, a query, or a fragment",
    );
  });
});
