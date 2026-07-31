import {
  CompetitorReportRuntimeError,
  generateCompetitorBatch,
  type CompetitorBatchId,
  type CompetitorReportRuntimeOptions,
} from "../../../lib/competitor-report-runtime";
import type { GlobalTextConfig } from "../../../lib/global-model-runtime";

type RouteOptions = Omit<CompetitorReportRuntimeOptions, "batchId"> & {
  requestBodyTimeoutMs?: number;
};

const MAX_REQUEST_BYTES = 128 * 1024;
const DEFAULT_REQUEST_BODY_TIMEOUT_MS = 30_000;
const NO_STORE_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
};

export function createCompetitorReportRoute(options: RouteOptions = {}) {
  const {
    requestBodyTimeoutMs = DEFAULT_REQUEST_BODY_TIMEOUT_MS,
    ...runtimeOptions
  } = options;
  const bodyTimeoutMs = validBodyTimeout(requestBodyTimeoutMs);

  return async function handleCompetitorReportRequest(
    request: Request,
  ): Promise<Response> {
    if (request.method !== "POST") {
      return errorResponse(
        "METHOD_NOT_ALLOWED",
        "仅支持 POST 请求。",
        405,
      );
    }

    try {
      const payload = await parseRequest(request, bodyTimeoutMs);
      const batch = await generateCompetitorBatch(
        payload.config as GlobalTextConfig,
        payload.input as Record<string, unknown>,
        {
          ...runtimeOptions,
          batchId: payload.batchId as CompetitorBatchId,
          signal: request.signal,
          egressMode: "server-proxy",
        },
      );
      return json({ ok: true, batch }, 200);
    } catch (error) {
      if (error instanceof RouteRequestError) {
        return errorResponse(error.code, error.message, error.status);
      }
      if (error instanceof CompetitorReportRuntimeError) {
        return errorResponse(error.code, error.message, error.status);
      }
      return errorResponse(
        "INTERNAL_ERROR",
        "服务暂时不可用，请稍后重试。",
        500,
      );
    }
  };
}

export const POST = createCompetitorReportRoute();

class RouteRequestError extends Error {
  constructor(
    readonly code:
      | "INVALID_JSON"
      | "INVALID_REQUEST"
      | "REQUEST_CANCELLED"
      | "REQUEST_BODY_TIMEOUT"
      | "REQUEST_TOO_LARGE",
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "RouteRequestError";
  }
}

async function parseRequest(
  request: Request,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength)
    && declaredLength > MAX_REQUEST_BYTES
  ) {
    throw new RouteRequestError(
      "REQUEST_TOO_LARGE",
      "请求内容过大，请精简后重试。",
      413,
    );
  }
  const text = await readRequestBody(request, timeoutMs);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RouteRequestError("INVALID_JSON", "请求格式无效。", 400);
  }
  if (!isRecord(parsed)) {
    throw new RouteRequestError("INVALID_REQUEST", "请求参数无效。", 400);
  }
  return parsed;
}

async function readRequestBody(
  request: Request,
  timeoutMs: number,
): Promise<string> {
  if (request.signal.aborted) {
    throw requestCancelled();
  }
  if (!request.body) {
    throw new RouteRequestError("INVALID_REQUEST", "请求参数无效。", 400);
  }
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let receivedBytes = 0;
  let timedOut = false;
  const cancelRead = () => {
    cancelReader(reader);
  };
  const timeout = setTimeout(() => {
    timedOut = true;
    cancelRead();
  }, timeoutMs);
  request.signal.addEventListener("abort", cancelRead, { once: true });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (request.signal.aborted) throw requestCancelled();
      if (timedOut) throw requestBodyTimeout();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > MAX_REQUEST_BYTES) {
        cancelReader(reader);
        throw new RouteRequestError(
          "REQUEST_TOO_LARGE",
          "请求内容过大，请精简后重试。",
          413,
        );
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } catch (error) {
    if (request.signal.aborted) throw requestCancelled();
    if (timedOut) throw requestBodyTimeout();
    if (error instanceof RouteRequestError) throw error;
    throw new RouteRequestError("INVALID_REQUEST", "请求参数无效。", 400);
  } finally {
    clearTimeout(timeout);
    request.signal.removeEventListener("abort", cancelRead);
    try {
      reader.releaseLock();
    } catch {
      // Cleanup failure must not replace the stable route result.
    }
  }
}

function requestCancelled(): RouteRequestError {
  return new RouteRequestError(
    "REQUEST_CANCELLED",
    "本次生成已取消。",
    499,
  );
}

function requestBodyTimeout(): RouteRequestError {
  return new RouteRequestError(
    "REQUEST_BODY_TIMEOUT",
    "请求内容读取超时。",
    408,
  );
}

function cancelReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): void {
  try {
    void reader.cancel().catch(() => undefined);
  } catch {
    // Cleanup failure must not replace the stable route result.
  }
}

function validBodyTimeout(value: number): number {
  return Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_REQUEST_BODY_TIMEOUT_MS;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: NO_STORE_HEADERS,
  });
}

function errorResponse(code: string, message: string, status: number): Response {
  return json({ ok: false, error: { code, message } }, status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
