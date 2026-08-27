export class ServiceError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

export function badRequest(code: string, message: string): ServiceError {
  return new ServiceError(code, 400, message);
}

export function conflict(code: string, message: string): ServiceError {
  return new ServiceError(code, 409, message);
}

export function notFound(message = "Attention item not found"): ServiceError {
  return new ServiceError("not_found", 404, message);
}

export function forbidden(message = "Credential does not grant the required scope"): ServiceError {
  return new ServiceError("forbidden", 403, message);
}

export function unauthorized(message = "A valid bearer credential is required"): ServiceError {
  return new ServiceError("unauthorized", 401, message);
}
