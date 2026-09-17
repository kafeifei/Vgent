/**
 * Typed server errors. The HTTP layer maps them by `instanceof` and reads
 * `status` / `code` off the instance — it never matches on message text.
 */
export class VgentServerError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(options: { message: string; status: number; code: string }) {
    super(options.message);
    this.name = new.target.name;
    this.status = options.status;
    this.code = options.code;
  }
}

export class BadRequestError extends VgentServerError {
  constructor(message: string, code = "bad_request") {
    super({ message, status: 400, code });
  }
}

export class UnauthorizedError extends VgentServerError {
  constructor(message = "缺少或无效的访问令牌", code = "unauthorized") {
    super({ message, status: 401, code });
  }
}

export class NotFoundError extends VgentServerError {
  constructor(message: string, code = "not_found") {
    super({ message, status: 404, code });
  }
}

export class ConflictError extends VgentServerError {
  constructor(message: string, code = "conflict") {
    super({ message, status: 409, code });
  }
}

export class NotImplementedError extends VgentServerError {
  constructor(message: string, code = "not_implemented") {
    super({ message, status: 501, code });
  }
}
