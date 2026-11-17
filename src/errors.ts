import { BadCredentialsError, SecurityError, SessionExpiredError } from "pawnote";

/** Error with an HTTP status and a stable machine code, understood by sidecar_connector.php. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    /** Members added to the error body (retry_after, candidates, fields…), never personal data. */
    public readonly extra: Record<string, unknown> = {},
    /** Headers added to the error answer (Retry-After). */
    public readonly headers: Record<string, string> = {},
  ) {
    super(code);
  }
}

/** Queue of the Pronote calls too long (P2): 429 rate_limited with retry_after (seconds) and Retry-After. */
export class RateLimitedError extends HttpError {
  constructor(public readonly retryAfter: number) {
    const seconds = Math.max(1, Math.ceil(retryAfter));
    super(429, "rate_limited", { retry_after: seconds }, { "retry-after": String(seconds) });
  }
}

/** Teacher-space request not implemented yet (see src/teacher/). */
export class NotImplementedError extends HttpError {
  constructor(feature: string) {
    super(501, `not_implemented:${feature}`);
  }
}

/** Converts any thrown value to [status, code] without leaking internals. */
export const toHttp = (error: unknown): [number, string] => {
  if (error instanceof HttpError) return [error.status, error.code];
  if (error instanceof SessionExpiredError) return [401, "session_expired"];
  if (error instanceof BadCredentialsError) return [401, "bad_credentials"];
  if (error instanceof SecurityError) return [409, "double_auth_required"];
  if (typeof error === "object" && error !== null) {
    if ("validation" in error) return [400, "invalid_request"];
    const status = (error as { statusCode?: unknown }).statusCode;
    if (typeof status === "number" && status >= 400 && status < 500) return [status, "invalid_request"];
  }
  return [502, "pronote_error"];
};
