export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const notFound = (what: string): HttpError => new HttpError(404, `${what} not found`);
export const badRequest = (message: string, details?: unknown): HttpError =>
  new HttpError(400, message, details);
