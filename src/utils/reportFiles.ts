import type { StaticFileStore } from "../model.js";
import type { ReportRepository } from "../repositories/api.js";
import { detectPluginRoots } from "./path.js";
import { buildReportFileUrl } from "./reports.js";

const acceptsHtml = (acceptHeader: string | undefined): boolean =>
  acceptHeader
    ?.toLowerCase()
    .split(",")
    .some((value) => value.trim().startsWith("text/html")) ?? false;

const uniquePaths = (paths: string[]): string[] => [...new Set(paths)];

const toDirectoryIndexPath = (filePath: string): string => `${filePath}/index.html`;

const getEntrypointRoot = (entrypoint: string | null): string | null =>
  entrypoint?.includes("/") ? entrypoint.split("/")[0] : null;

const getPluginRootLookupPaths = (requestedPath: string, entrypoint: string | null): string[] => {
  const entrypointRoot = getEntrypointRoot(entrypoint);

  if (!entrypointRoot) {
    return [requestedPath];
  }

  if (requestedPath.startsWith(`${entrypointRoot}/`)) {
    return uniquePaths([requestedPath, requestedPath.slice(entrypointRoot.length + 1)]);
  }

  if (requestedPath === entrypointRoot) {
    return [requestedPath];
  }

  return uniquePaths([requestedPath, `${entrypointRoot}/${requestedPath}`]);
};

const removeFirstPathSegment = (filePath: string): string | null => {
  const separatorIndex = filePath.indexOf("/");

  if (separatorIndex === -1) {
    return null;
  }

  const stripped = filePath.slice(separatorIndex + 1);

  return stripped ? stripped : null;
};

const resolveReportEntrypoint = async (fileStore: StaticFileStore, reportId: string): Promise<string | null> => {
  if (await fileStore.exists(reportId, "index.html")) {
    return "index.html";
  }

  const pluginRoots = detectPluginRoots(await fileStore.list(reportId));

  return pluginRoots.length === 1 ? `${pluginRoots[0]}/index.html` : null;
};

export const resolveReportEntrypointUrl = async (
  reportsRepository: ReportRepository,
  fileStore: StaticFileStore,
  reportId: string,
): Promise<{ url: string } | { error: "entrypoint not found" | "report not found" }> => {
  const report = await reportsRepository.findById(reportId);

  if (!report) {
    return { error: "report not found" };
  }

  const entrypoint = await resolveReportEntrypoint(fileStore, report.id);

  if (!entrypoint) {
    return { error: "entrypoint not found" };
  }

  return { url: buildReportFileUrl(report.id, ...entrypoint.split("/")) };
};

export const getReportFile = async (
  reportsRepository: ReportRepository,
  fileStore: StaticFileStore,
  reportId: string,
  requestedPath: string,
  acceptHeader: string | undefined,
): Promise<{ data: Uint8Array<ArrayBuffer>; path: string } | { error: "file not found" | "report not found" }> => {
  const report = await reportsRepository.findById(reportId);

  if (!report) {
    return { error: "report not found" };
  }

  let responsePath = requestedPath;
  let file: Uint8Array<ArrayBuffer> | null = null;
  const requestAcceptsHtml = acceptsHtml(acceptHeader);
  const triedAssetPaths = new Set<string>();
  const triedReportPaths = new Set<string>();
  const unprefixedPath = removeFirstPathSegment(requestedPath);

  const tryReportPath = async (filePath: string): Promise<boolean> => {
    if (triedReportPaths.has(filePath)) {
      return false;
    }

    triedReportPaths.add(filePath);
    file = await fileStore.get(report.id, filePath);

    if (file) {
      responsePath = filePath;
      return true;
    }

    return false;
  };

  const tryAssetPath = async (filePath: string): Promise<boolean> => {
    if (triedAssetPaths.has(filePath)) {
      return false;
    }

    triedAssetPaths.add(filePath);
    file = await fileStore.getAsset(filePath);

    if (file) {
      responsePath = filePath;
      return true;
    }

    return false;
  };

  if (await tryReportPath(requestedPath)) {
    return { data: file!, path: responsePath };
  }

  if (await tryReportPath(toDirectoryIndexPath(requestedPath))) {
    return { data: file!, path: responsePath };
  }

  if (unprefixedPath && (await tryReportPath(unprefixedPath))) {
    return { data: file!, path: responsePath };
  }

  if (unprefixedPath && (await tryReportPath(toDirectoryIndexPath(unprefixedPath)))) {
    return { data: file!, path: responsePath };
  }

  if (!requestAcceptsHtml) {
    if (await tryAssetPath(requestedPath)) {
      return { data: file!, path: responsePath };
    }

    if (unprefixedPath && (await tryAssetPath(unprefixedPath))) {
      return { data: file!, path: responsePath };
    }
  }

  const entrypoint = await resolveReportEntrypoint(fileStore, report.id);
  const lookupPaths = getPluginRootLookupPaths(requestedPath, entrypoint);

  for (const filePath of lookupPaths) {
    if (await tryReportPath(filePath)) {
      return { data: file!, path: responsePath };
    }
  }

  for (const filePath of lookupPaths.map(toDirectoryIndexPath)) {
    if (await tryReportPath(filePath)) {
      return { data: file!, path: responsePath };
    }
  }

  if (requestAcceptsHtml && entrypoint && (await tryReportPath(entrypoint))) {
    return { data: file!, path: responsePath };
  }

  for (const assetPath of lookupPaths) {
    if (await tryAssetPath(assetPath)) {
      return { data: file!, path: responsePath };
    }
  }

  if (requestAcceptsHtml) {
    if (await tryAssetPath(requestedPath)) {
      return { data: file!, path: responsePath };
    }

    if (unprefixedPath && (await tryAssetPath(unprefixedPath))) {
      return { data: file!, path: responsePath };
    }
  }

  return { error: "file not found" };
};
