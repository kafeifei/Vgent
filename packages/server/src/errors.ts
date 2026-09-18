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

/**
 * The engine itself cannot run on this machine — not logged in, not installed,
 * no credential in the environment. The request is fine; the host is not ready,
 * so it is a 503 and the message says what to fix.
 */
export class EngineUnavailableError extends VgentServerError {
  constructor(message: string, code = "engine_unavailable") {
    super({ message, status: 503, code });
  }
}

/**
 * A turn frozen by `EngineRunner.suspend()` could not be picked up again: the
 * runtime that was holding it is gone (the machine rebooted, the bridge was
 * killed, the port moved). Nothing about the request is wrong, so the run
 * manager converts the thread to the ordinary interrupted state instead of
 * letting the failure surface as a raw engine error.
 */
export class TurnResumeFailedError extends VgentServerError {
  constructor(message: string, options?: { cause?: unknown }) {
    super({ message, status: 503, code: "turn_resume_failed" });
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/**
 * A model call the server made on its own behalf (not through an engine's
 * stream) failed upstream — the request was fine, the provider was not. The
 * provider's own message is carried through so the user sees what broke.
 */
export class UpstreamModelError extends VgentServerError {
  constructor(message: string, code = "model_failed") {
    super({ message, status: 502, code });
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
