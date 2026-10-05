import { describe, expect, it } from "vitest";

import { createErrorLog } from "../../src/utils/error.js";

describe("createErrorLog", () => {
  it("promotes a nested cause message while retaining the full error chain", () => {
    const cause = new Error("D1 DB is overloaded. Too many requests queued.");
    const error = new Error("", { cause });

    expect(createErrorLog("request failed", error)).toMatchObject({
      error: {
        cause: {
          message: "D1 DB is overloaded. Too many requests queued.",
          name: "Error",
        },
        message: "",
        name: "Error",
      },
      event: "request failed",
      message: "D1 DB is overloaded. Too many requests queued.",
    });
  });
});
