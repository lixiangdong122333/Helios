export type HeliosErrorCode =
  | "INVALID_ARGUMENT"
  | "PERMISSION_DENIED"
  | "RESOURCE_EXHAUSTED"
  | "DEADLINE_EXCEEDED"
  | "UPSTREAM_ERROR"
  | "INTERNAL_ERROR";

export class HeliosError extends Error {
  readonly code: HeliosErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: HeliosErrorCode,
    message: string,
    details?: Record<string, unknown>,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "HeliosError";
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
