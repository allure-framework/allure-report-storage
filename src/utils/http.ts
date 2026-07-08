import type { Context } from "hono";

import type { BuildHttpAppOptions, DynamicBuildAppOptions } from "../model.js";

export const PUBLIC_API_PATHS = ["/api/ping", "/api/token", "/api/projects/main-branch"];

export const isApiPath = (pathname: string): boolean => pathname === "/api" || pathname.startsWith("/api/");

export const isPublicApiRequest = (pathname: string): boolean => PUBLIC_API_PATHS.includes(pathname);

export const normalizeMainBranch = (branch: string | undefined): string => {
  const normalized = branch?.trim();

  return normalized ? normalized : "main";
};

export const normalizeStringParam = (value: unknown): string | null => {
  const normalized = typeof value === "string" ? value.trim() : "";

  return normalized ? normalized : null;
};

export const requireEnvValue = (value: string, name: string): string => {
  const normalized = value.trim();

  if (!normalized) {
    throw new Error(`${name} environment variable is required`);
  }

  return normalized;
};

export const unauthorizedResponse = (c: Context): Response =>
  c.json({ error: "unauthorized" }, 401, { "www-authenticate": 'Bearer realm="allure-report-storage"' });

export const parseBearerToken = (authorizationHeader: string | undefined): string | null => {
  const match = authorizationHeader?.match(/^Bearer\s+(.+)$/i);

  return match?.[1]?.trim() || null;
};

const textEncoder = new TextEncoder();

export const tokensEqual = (left: string, right: string): boolean => {
  const leftBytes = textEncoder.encode(left);
  const rightBytes = textEncoder.encode(right);
  let difference = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);

  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }

  return difference === 0;
};

export const isDynamicOptions = <Bindings extends object>(
  options: BuildHttpAppOptions<Bindings>,
): options is DynamicBuildAppOptions<Bindings> => "createContext" in options;
