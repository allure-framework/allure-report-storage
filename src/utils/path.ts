export const normalizeUploadPath = (rawPath: string): string | null => {
  if (
    !rawPath ||
    rawPath.includes("\0") ||
    rawPath.includes("\\") ||
    rawPath.startsWith("/") ||
    /^[a-zA-Z]:/.test(rawPath)
  ) {
    return null;
  }

  const segments = rawPath.split("/");

  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    return null;
  }

  return rawPath;
};

export const detectPluginRoots = (paths: string[]): string[] => {
  const roots = new Set<string>();

  for (const filePath of paths) {
    const segments = filePath.split("/");

    if (segments.length === 2 && segments[1] === "index.html") {
      roots.add(segments[0]);
    }
  }

  return Array.from(roots).sort();
};

export const historyFileName = (reportId: string): string => `${encodeURIComponent(reportId)}.json`;
