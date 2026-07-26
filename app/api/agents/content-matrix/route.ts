import {
  ContentMatrixRuntimeError,
  createContentMatrixRuntime,
} from "../../../lib/content-matrix-runtime";

type RouteOptions = Parameters<typeof createContentMatrixRuntime>[0];

const MAX_REQUEST_BYTES = 128 * 1024;
const NO_STORE_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
};

export function createContentMatrixRoute(options: RouteOptions = {}) {
  const runtime = createContentMatrixRuntime(options);

  return async function handleContentMatrixRequest(
    request: Request,
  ): Promise<Response> {
    try {
      const payload = await parseRequest(request);
      const action = payload.action;

      if (action === "test") {
        const result = await runtime.testConnection(payload);
        return json(
          {
            ok: true,
            action: "test",
            connected: result.connected,
            modelAvailable: result.modelAvailable,
          },
          200,
        );
      }

      if (action === "run") {
        const result = await runtime.runStage(payload);
        return json(
          {
            ok: true,
            action: "run",
            stage: result.stage,
            markdown: result.markdown,
          },
          200,
        );
      }

      return errorResponse("INVALID_ACTION", "请求操作无效。", 400);
    } catch (error) {
      if (error instanceof RouteRequestError) {
        return errorResponse(error.code, error.message, error.status);
      }
      if (error instanceof ContentMatrixRuntimeError) {
        return errorResponse(error.code, error.message, error.status);
      }
      return errorResponse("INTERNAL_ERROR", "服务暂时不可用，请稍后重试。", 500);
    }
  };
}

export const POST = createContentMatrixRoute();

class RouteRequestError extends Error {
  constructor(
    readonly code: "REQUEST_TOO_LARGE" | "INVALID_JSON",
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "RouteRequestError";
  }
}

async function parseRequest(
  request: Request,
): Promise<Record<string, unknown>> {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    throw new RouteRequestError(
      "REQUEST_TOO_LARGE",
      "请求内容过大，请精简后重试。",
      413,
    );
  }

  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_REQUEST_BYTES) {
    throw new RouteRequestError(
      "REQUEST_TOO_LARGE",
      "请求内容过大，请精简后重试。",
      413,
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new RouteRequestError("INVALID_JSON", "请求格式无效。", 400);
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new RouteRequestError("INVALID_JSON", "请求格式无效。", 400);
  }
  return payload as Record<string, unknown>;
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
