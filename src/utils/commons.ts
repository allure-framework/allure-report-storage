export const trimSlashes = (value: string): string => value.replace(/^\/+|\/+$/g, "");

export const joinObjectKey = (...segments: Array<string | undefined>): string =>
  segments
    .map((segment) => (segment === undefined ? "" : trimSlashes(segment)))
    .filter(Boolean)
    .join("/");
