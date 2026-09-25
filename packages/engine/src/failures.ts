import { APICallError, type LanguageModelMiddleware } from "ai";

export type FailureClass =
  | "authorization"
  | "model-unavailable"
  | "rate-limit"
  | "upstream"
  | "context-capacity"
  | "timeout"
  | "connection"
  | "cancelled"
  | "unknown";
export function classifyFailure(error: unknown): FailureClass {
  let current = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 8 && current != null && !seen.has(current); depth++) {
    seen.add(current);
    if (APICallError.isInstance(current)) {
      let code: unknown;
      try {
        code = JSON.parse(current.responseBody ?? "{}")?.error?.code;
      } catch {
        /* not JSON */
      }
      if (code === "context_length_exceeded" || code === "context_window_exceeded" || current.statusCode === 413) return "context-capacity";
      if (current.statusCode === 401 || current.statusCode === 403) return "authorization";
      if (current.statusCode === 404 || code === "model_not_found" || code === "model_not_supported") return "model-unavailable";
      if (current.statusCode === 429) return "rate-limit";
      if (current.statusCode != null && current.statusCode >= 500) return "upstream";
    }
    if (current instanceof Error) {
      if (current.name === "ContextCapacityError") return "context-capacity";
      if (current.name === "AbortError") return "cancelled";
      if (current.name === "TimeoutError") return "timeout";
      const code = (current as Error & { code?: string }).code;
      if (code === "UND_ERR_CONNECT_TIMEOUT" || code === "ETIMEDOUT") return "timeout";
      if (["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "UND_ERR_SOCKET"].includes(code ?? "")) return "connection";
      current = (current as Error & { lastError?: unknown }).lastError ?? current.cause;
    } else break;
  }
  return "unknown";
}

/** SDK retries remain bounded and only occur before a stream/tool side effect. */
export function observeProvider(onAttempt: () => void, onFailure: (kind: FailureClass) => void): LanguageModelMiddleware {
  const failed = (error: unknown): never => {
    const kind = classifyFailure(error);
    onFailure(kind);
    if (["authorization", "model-unavailable", "context-capacity"].includes(kind)) {
      // A generic Error is deliberately non-retryable even if a gateway marked its 403 retryable.
      throw new Error(error instanceof Error ? error.message : String(error), { cause: error });
    }
    throw error;
  };
  return {
    wrapGenerate: async ({ doGenerate }) => {
      onAttempt();
      try {
        return await doGenerate();
      } catch (error) {
        return failed(error);
      }
    },
    wrapStream: async ({ doStream }) => {
      onAttempt();
      try {
        return await doStream();
      } catch (error) {
        return failed(error);
      }
    },
  };
}
