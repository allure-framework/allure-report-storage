export const normalizeUploadPath = (rawPath: string): string | null => {
  const candidate = rawPath.trim();

  if (!candidate || candidate === "/") {
    return null;
  }

  const normalized = candidate.replaceAll("\\", "/").replace(/^\/+/, "");

  if (!normalized) {
    return null;
  }

  const segments = normalized.split("/");

  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    return null;
  }

  return segments.join("/");
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
