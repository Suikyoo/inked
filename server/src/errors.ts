/** An error that maps directly to an API response `{ error: code, message?, ...extra }`. */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message?: string,
    readonly extra?: Record<string, unknown>,
    readonly headers?: Record<string, string>,
  ) {
    super(message ?? '');
  }
}

export const notFound = () => new ApiError(404, 'not_found');
export const unauthorized = () => new ApiError(401, 'unauthorized');
