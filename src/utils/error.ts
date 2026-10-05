export interface ErrorDetails {
  cause?: ErrorDetails;
  message: string;
  name: string;
  stack?: string;
}

export interface ErrorLog {
  error: ErrorDetails;
  event: string;
  message: string;
}

const MAX_CAUSE_DEPTH = 5;

const getStringProperty = (value: object, property: "message" | "name" | "stack"): string | undefined => {
  const candidate = Reflect.get(value, property);

  return typeof candidate === "string" ? candidate : undefined;
};

const describeError = (value: unknown, seen: Set<object>, depth: number): ErrorDetails => {
  if (typeof value !== "object" || value === null) {
    return {
      message: String(value),
      name: typeof value,
    };
  }

  if (seen.has(value)) {
    return {
      message: "Circular error cause",
      name: "Error",
    };
  }

  const name = getStringProperty(value, "name") || value.constructor?.name || "Error";
  const message = getStringProperty(value, "message") ?? String(value);
  const stack = getStringProperty(value, "stack");
  const details: ErrorDetails = {
    message,
    name,
    ...(stack ? { stack } : {}),
  };
  const cause = Reflect.get(value, "cause");

  if (cause !== undefined) {
    if (depth >= MAX_CAUSE_DEPTH) {
      details.cause = {
        message: "Error cause chain truncated",
        name: "Error",
      };
    } else {
      seen.add(value);
      details.cause = describeError(cause, seen, depth + 1);
      seen.delete(value);
    }
  }

  return details;
};

const findMessage = (error: ErrorDetails): string =>
  error.message || (error.cause ? findMessage(error.cause) : error.name);

export const createErrorLog = (event: string, error: unknown): ErrorLog => {
  const details = describeError(error, new Set(), 0);

  return {
    error: details,
    event,
    message: findMessage(details),
  };
};
