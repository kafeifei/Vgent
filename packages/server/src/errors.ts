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

/** The project's `repoPath` is not (inside) a git work tree, so there is nothing to diff. */
export class NotAGitRepoError extends VgentServerError {
  constructor(message: string, code = "not_a_git_repo") {
    super({ message, status: 409, code });
  }
}

/** No `git` on PATH: the machine, not the request, is at fault. */
export class GitUnavailableError extends VgentServerError {
  constructor(message = "找不到 git 可执行文件", code = "git_unavailable") {
    super({ message, status: 503, code });
  }
}

/** Any other git failure; the message carries the trimmed stderr. */
export class GitError extends VgentServerError {
  constructor(message: string, code = "git_failed") {
    super({ message, status: 500, code });
  }
}
