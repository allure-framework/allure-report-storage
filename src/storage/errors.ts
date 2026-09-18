export type StorageHttpStatus = 429 | 500 | 503;

export class StorageOperationError extends Error {
  constructor(
    readonly publicMessage: string,
    readonly status: StorageHttpStatus,
    readonly retryAfter?: number,
    options?: ErrorOptions,
  ) {
    super(publicMessage, options);
    this.name = "StorageOperationError";
  }
}

/**
 * Extracts the numeric error code returned by Cloudflare's R2 Workers API.
 *
 * Depending on the runtime error shape, Cloudflare exposes the code either as
 * `error.code` or as a numeric suffix in the error message, for example
 * `put: Service is temporarily unavailable. (10043)`.
 */
const readR2ErrorCode = (error: unknown): number | undefined => {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }

  const candidate = error as { code?: unknown; message?: unknown };

  if (typeof candidate.code === "number") {
    return candidate.code;
  }

  if (typeof candidate.message !== "string") {
    return undefined;
  }

  const match = candidate.message.match(/\((\d+)\)\s*$/);

  return match ? Number(match[1]) : undefined;
};

/**
 * Maps known transient Cloudflare R2 failures to stable HTTP-facing errors.
 *
 * Unknown R2 failures remain unchanged so the application's normal error
 * handling can treat them as unexpected internal errors.
 */
export const mapR2Error = (error: unknown): unknown => {
  switch (readR2ErrorCode(error)) {
    case 10001:
      return new StorageOperationError("storage service encountered a temporary error", 500, undefined, {
        cause: error,
      });
    case 10043:
      return new StorageOperationError("storage service is temporarily unavailable", 503, 1, { cause: error });
    case 10058:
      return new StorageOperationError("storage write is temporarily throttled", 429, 1, { cause: error });
    default:
      return error;
  }
};

/**
 * Runs a single Cloudflare R2 binding operation and normalizes known errors.
 *
 * This wrapper intentionally does not retry. Upload request streams are
 * single-use, so the client owns retries and sends a fresh stream per attempt.
 */
export const runR2Operation = async <T>(operation: () => Promise<T>): Promise<T> => {
  try {
    return await operation();
  } catch (error) {
    throw mapR2Error(error);
  }
};
