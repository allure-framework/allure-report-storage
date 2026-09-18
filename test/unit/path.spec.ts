import { describe, expect, it } from "vitest";

import { normalizeUploadPath } from "../../src/utils/path.js";

describe("normalizeUploadPath", () => {
  it.each(["index.html", "awesome/data/test-results/result.json", "path with spaces/file %.txt", "путь/файл.json"])(
    "preserves canonical relative paths: %s",
    (filePath) => {
      expect(normalizeUploadPath(filePath)).toBe(filePath);
    },
  );

  it.each([
    "",
    "/absolute.txt",
    "nested//file.txt",
    "nested/./file.txt",
    "nested/../file.txt",
    "C:drive-relative.txt",
    "C:\\absolute.txt",
    "\\\\server\\share\\file.txt",
    "nested\\file.txt",
    "nul\0file.txt",
  ])("rejects non-canonical or unsafe paths: %s", (filePath) => {
    expect(normalizeUploadPath(filePath)).toBeNull();
  });
});
