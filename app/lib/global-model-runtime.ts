export type GlobalTextConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
};

export type GlobalImageConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
};

export type ChatTurn = {
  role: "user" | "assistant";
  content: string;
};

type Fetch = typeof fetch;

export type GlobalModelRuntimeOptions = {
  fetchImpl?: Fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
};

const TEXT_TEST_PATH = ["chat", "completions"] as const;
const IMAGE_TEST_PATH = ["models"] as const;
const CHAT_PATH = ["chat", "completions"] as const;

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_URL_LENGTH = 2_048;
const MAX_KEY_LENGTH = 4_096;
const MAX_MODEL_LENGTH = 200;
const MAX_CHAT_TURNS = 40;
const MAX_TURN_LENGTH = 12_000;
const MAX_TOTAL_CHAT_LENGTH = 48_000;
const MAX_ROUTE_BODY_BYTES = 64 * 1024;
const MAX_PROVIDER_RESPONSE_BYTES = 256 * 1024;
const MAX_PROVIDER_MODELS = 1_000;
const MAX_PROVIDER_MODEL_ID_LENGTH = 200;
const MAX_CHAT_REPLY_LENGTH = 24_000;
const CHAT_MAX_TOKENS = 2_048;
const TRUSTED_PROXY_HOSTNAMES = new Set(["api.openai.com"]);

const SAFE_ERRORS = {
  INVALID_REQUEST: ["INVALID_REQUEST", "请求参数无效。", 400],
  REQUEST_TOO_LARGE: [
    "REQUEST_TOO_LARGE",
    "请求内容过大，请精简后重试。",
    413,
  ],
  INVALID_CONFIG: ["INVALID_CONFIG", "模型配置不完整或格式无效。", 400],
  UNSAFE_URL: ["UNSAFE_URL", "接口地址必须是安全的 HTTPS 公网地址。", 400],
  INPUT_TOO_LARGE: ["INPUT_TOO_LARGE", "输入内容过长，请精简后重试。", 413],
  MODEL_NOT_FOUND: ["MODEL_NOT_FOUND", "模型列表中未找到指定模型。", 400],
  REQUEST_CANCELLED: ["REQUEST_CANCELLED", "本次请求已取消。", 499],
  AUTH_FAILED: ["AUTH_FAILED", "模型服务鉴权失败，请检查 API Key。", 401],
  RATE_LIMITED: ["RATE_LIMITED", "模型服务请求过于频繁，请稍后重试。", 429],
  PROVIDER_UNAVAILABLE: [
    "PROVIDER_UNAVAILABLE",
    "模型服务暂时不可用，请稍后重试。",
    502,
  ],
  PROVIDER_REQUEST_FAILED: [
    "PROVIDER_REQUEST_FAILED",
    "模型服务请求失败，请检查配置。",
    502,
  ],
  PROVIDER_TIMEOUT: [
    "PROVIDER_TIMEOUT",
    "模型服务响应超时，请稍后重试。",
    504,
  ],
  INVALID_PROVIDER_RESPONSE: [
    "INVALID_PROVIDER_RESPONSE",
    "模型服务返回格式异常，请稍后重试。",
    502,
  ],
  PROVIDER_RESPONSE_TOO_LARGE: [
    "PROVIDER_RESPONSE_TOO_LARGE",
    "模型服务返回内容过大，请缩小请求后重试。",
    502,
  ],
} as const;

type SafeErrorName = keyof typeof SAFE_ERRORS;

export class SafeModelError extends Error {
  readonly code: (typeof SAFE_ERRORS)[SafeErrorName][0];
  readonly status: number;

  constructor(name: SafeErrorName) {
    const [code, message, status] = SAFE_ERRORS[name];
    super(message);
    this.name = "SafeModelError";
    this.code = code;
    this.status = status;
  }
}

export function usesBrowserDirectModelRoute(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return (
      url.protocol === "https:"
      && url.hostname.toLowerCase() === "apinebula.ai"
      && url.username === ""
      && url.password === ""
    );
  } catch {
    return false;
  }
}

export async function testTextConnection(
  config: GlobalTextConfig,
  options: GlobalModelRuntimeOptions = {},
): Promise<void> {
  const validConfig = validateConfig(config);
  const body = await fetchProviderJson(
    buildRequest(validConfig, TEXT_TEST_PATH, {
      method: "POST",
      headers: providerHeaders(validConfig, true),
      body: JSON.stringify({
        model: validConfig.model,
        messages: [{ role: "user", content: "只回复：连接正常" }],
        max_tokens: 16,
      }),
    }),
    options,
  );
  parseChatText(body);
}

export async function testImageConnection(
  config: GlobalImageConfig,
  options: GlobalModelRuntimeOptions = {},
): Promise<void> {
  const validConfig = validateConfig(config);
  const body = await fetchProviderJson(
    buildRequest(validConfig, IMAGE_TEST_PATH, {
      method: "GET",
      headers: providerHeaders(validConfig, false),
    }),
    options,
  );
  const modelIds = parseModelIds(body);
  if (!modelIds.includes(validConfig.model)) {
    throw new SafeModelError("MODEL_NOT_FOUND");
  }
}

export async function generateChatReply(
  config: GlobalTextConfig,
  turns: ChatTurn[],
  options: GlobalModelRuntimeOptions = {},
): Promise<string> {
  const validConfig = validateConfig(config);
  const validTurns = validateTurns(turns);
  const body = await fetchProviderJson(
    buildRequest(validConfig, CHAT_PATH, {
      method: "POST",
      headers: providerHeaders(validConfig, true),
      body: JSON.stringify({
        model: validConfig.model,
        messages: validTurns,
        max_tokens: CHAT_MAX_TOKENS,
      }),
    }),
    options,
  );
  return redactSecret(parseChatText(body), validConfig.apiKey);
}

export function safeModelErrorMessage(
  error: unknown,
  apiKey: string,
): string {
  if (error instanceof SafeModelError) {
    return redactSecret(error.message, apiKey);
  }
  return SAFE_ERRORS.PROVIDER_UNAVAILABLE[1];
}

export async function readBoundedModelRequest(
  request: Request,
): Promise<Record<string, unknown>> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength)
    && declaredLength > MAX_ROUTE_BODY_BYTES
  ) {
    throw new SafeModelError("REQUEST_TOO_LARGE");
  }

  if (!request.body) {
    throw new SafeModelError("INVALID_REQUEST");
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_ROUTE_BODY_BYTES) {
        await reader.cancel();
        throw new SafeModelError("REQUEST_TOO_LARGE");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof SafeModelError) throw error;
    if (request.signal.aborted) {
      throw new SafeModelError("REQUEST_CANCELLED");
    }
    throw new SafeModelError("INVALID_REQUEST");
  } finally {
    reader.releaseLock();
  }

  const bodyBytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bodyBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bodyBytes));
  } catch {
    throw new SafeModelError("INVALID_REQUEST");
  }
  if (!isRecord(parsed)) {
    throw new SafeModelError("INVALID_REQUEST");
  }
  return parsed;
}

export function noStoreJson(
  body: Record<string, unknown>,
  status = 200,
): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

export function modelErrorResponse(error: unknown): Response {
  const safeError =
    error instanceof SafeModelError
      ? error
      : new SafeModelError("PROVIDER_UNAVAILABLE");
  return noStoreJson(
    {
      ok: false,
      code: safeError.code,
      message: safeModelErrorMessage(safeError, ""),
    },
    safeError.status,
  );
}

type ValidatedConfig = GlobalTextConfig & {
  baseUrl: string;
};

function validateConfig(input: unknown): ValidatedConfig {
  if (!isRecord(input)) {
    throw new SafeModelError("INVALID_CONFIG");
  }
  const rawBaseUrl = input.baseUrl;
  const rawApiKey = input.apiKey;
  const rawModel = input.model;
  if (
    typeof rawBaseUrl !== "string"
    || typeof rawApiKey !== "string"
    || typeof rawModel !== "string"
    || rawBaseUrl.length > MAX_URL_LENGTH
    || rawApiKey.length > MAX_KEY_LENGTH
    || rawModel.length > MAX_MODEL_LENGTH
    || hasControlCharacter(rawApiKey)
    || hasControlCharacter(rawModel)
  ) {
    throw new SafeModelError("INVALID_CONFIG");
  }

  const baseUrl = rawBaseUrl.trim();
  const apiKey = rawApiKey.trim();
  const model = rawModel.trim();
  if (!baseUrl || !apiKey || !model) {
    throw new SafeModelError("INVALID_CONFIG");
  }

  return {
    baseUrl: validatePublicBaseUrl(baseUrl),
    apiKey,
    model,
  };
}

function validateTurns(input: unknown): ChatTurn[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new SafeModelError("INVALID_REQUEST");
  }
  if (input.length > MAX_CHAT_TURNS) {
    throw new SafeModelError("INPUT_TOO_LARGE");
  }

  let totalLength = 0;
  return input.map((turn) => {
    if (
      !isRecord(turn)
      || (turn.role !== "user" && turn.role !== "assistant")
      || typeof turn.content !== "string"
    ) {
      throw new SafeModelError("INVALID_REQUEST");
    }
    if (!turn.content.trim()) {
      throw new SafeModelError("INVALID_REQUEST");
    }
    if (turn.content.length > MAX_TURN_LENGTH) {
      throw new SafeModelError("INPUT_TOO_LARGE");
    }
    totalLength += turn.content.length;
    if (totalLength > MAX_TOTAL_CHAT_LENGTH) {
      throw new SafeModelError("INPUT_TOO_LARGE");
    }
    return {
      role: turn.role,
      content: turn.content,
    };
  });
}

function validatePublicBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SafeModelError("UNSAFE_URL");
  }
  if (
    url.protocol !== "https:"
    || url.port !== ""
    || url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== ""
    || !url.hostname
    || !TRUSTED_PROXY_HOSTNAMES.has(url.hostname.toLowerCase())
    || isBlockedHostname(url.hostname)
  ) {
    throw new SafeModelError("UNSAFE_URL");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function isBlockedHostname(value: string): boolean {
  const hostname = value
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "")
    .toLowerCase();
  if (
    hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
  ) {
    return true;
  }

  const ipv4 = parseIpv4(hostname);
  if (ipv4) return isBlockedIpv4(ipv4);

  const ipv6 = parseIpv6(hostname);
  if (!ipv6) return false;
  if (ipv6.every((part) => part === 0)) return true;
  if (ipv6.slice(0, 7).every((part) => part === 0) && ipv6[7] === 1) {
    return true;
  }
  if ((ipv6[0] & 0xfe00) === 0xfc00 || (ipv6[0] & 0xffc0) === 0xfe80) {
    return true;
  }
  const mappedIpv4 =
    ipv6.slice(0, 5).every((part) => part === 0)
    && (ipv6[5] === 0 || ipv6[5] === 0xffff);
  return mappedIpv4
    ? isBlockedIpv4([
        ipv6[6] >> 8,
        ipv6[6] & 0xff,
        ipv6[7] >> 8,
        ipv6[7] & 0xff,
      ])
    : false;
}

function parseIpv4(hostname: string): number[] | null {
  const parts = hostname.split(".");
  if (parts.length !== 4) return null;
  const numbers = parts.map((part) =>
    /^\d{1,3}$/.test(part) ? Number(part) : Number.NaN,
  );
  return numbers.every(
    (part) => Number.isInteger(part) && part >= 0 && part <= 255,
  )
    ? numbers
    : null;
}

function isBlockedIpv4([first, second]: number[]): boolean {
  return (
    first === 0
    || first === 10
    || first === 127
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 198 && (second === 18 || second === 19))
    || first >= 224
  );
}

function parseIpv6(hostname: string): number[] | null {
  if (!hostname.includes(":")) return null;
  const halves = hostname.split("::");
  if (halves.length > 2) return null;
  const left = parseIpv6Half(halves[0]);
  const right = parseIpv6Half(halves[1] ?? "");
  if (!left || !right) return null;
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  return [...left, ...Array.from({ length: missing }, () => 0), ...right];
}

function parseIpv6Half(value: string): number[] | null {
  if (!value) return [];
  const parsed = value.split(":").map((group) =>
    /^[0-9a-f]{1,4}$/i.test(group)
      ? Number.parseInt(group, 16)
      : Number.NaN,
  );
  return parsed.every(Number.isInteger) ? parsed : null;
}

function buildRequest(
  config: ValidatedConfig,
  segments: readonly string[],
  init: RequestInit,
) {
  return {
    url: appendEndpoint(config.baseUrl, segments),
    init,
  };
}

function appendEndpoint(baseUrl: string, segments: readonly string[]): string {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/, "");
  url.pathname = `${basePath}/${segments.join("/")}`;
  return url.toString();
}

function providerHeaders(
  config: ValidatedConfig,
  includeContentType: boolean,
): Headers {
  const headers = new Headers({
    accept: "application/json",
    authorization: `Bearer ${config.apiKey}`,
  });
  if (includeContentType) headers.set("content-type", "application/json");
  return headers;
}

async function fetchProviderJson(
  request: { url: string; init: RequestInit },
  options: GlobalModelRuntimeOptions,
): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const callerSignal = options.signal;
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort();

  if (callerSignal?.aborted) {
    throw new SafeModelError("REQUEST_CANCELLED");
  }
  callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetchImpl(request.url, {
      ...request.init,
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new SafeModelError("AUTH_FAILED");
      }
      if (response.status === 429) {
        throw new SafeModelError("RATE_LIMITED");
      }
      if (response.status >= 500) {
        throw new SafeModelError("PROVIDER_UNAVAILABLE");
      }
      throw new SafeModelError("PROVIDER_REQUEST_FAILED");
    }

    try {
      return await readBoundedProviderJson(response, controller.signal);
    } catch (error) {
      if (error instanceof SafeModelError) throw error;
      if (callerSignal?.aborted) {
        throw new SafeModelError("REQUEST_CANCELLED");
      }
      if (timedOut || isAbortError(error, controller.signal)) {
        throw new SafeModelError("PROVIDER_TIMEOUT");
      }
      throw new SafeModelError("INVALID_PROVIDER_RESPONSE");
    }
  } catch (error) {
    if (error instanceof SafeModelError) throw error;
    if (callerSignal?.aborted) {
      throw new SafeModelError("REQUEST_CANCELLED");
    }
    if (timedOut || isAbortError(error, controller.signal)) {
      throw new SafeModelError("PROVIDER_TIMEOUT");
    }
    throw new SafeModelError("PROVIDER_UNAVAILABLE");
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
}

async function readBoundedProviderJson(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength)
    && declaredLength > MAX_PROVIDER_RESPONSE_BYTES
  ) {
    await response.body?.cancel();
    throw new SafeModelError("PROVIDER_RESPONSE_TOO_LARGE");
  }
  if (!response.body) {
    throw new SafeModelError("INVALID_PROVIDER_RESPONSE");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let aborted = false;
  const abortRead = () => {
    aborted = true;
    void reader.cancel();
  };
  signal.addEventListener("abort", abortRead, { once: true });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (aborted) throw new DOMException("Aborted", "AbortError");
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel();
        throw new SafeModelError("PROVIDER_RESPONSE_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", abortRead);
    reader.releaseLock();
  }

  const bodyBytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bodyBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bodyBytes));
  } catch {
    throw new SafeModelError("INVALID_PROVIDER_RESPONSE");
  }
}

function isAbortError(error: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted
    || (error instanceof DOMException && error.name === "AbortError")
  );
}

function parseModelIds(body: unknown): string[] {
  if (!isRecord(body) || !Array.isArray(body.data)) {
    throw new SafeModelError("INVALID_PROVIDER_RESPONSE");
  }
  if (body.data.length > MAX_PROVIDER_MODELS) {
    throw new SafeModelError("PROVIDER_RESPONSE_TOO_LARGE");
  }
  return body.data.map((entry) => {
    if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id) {
      throw new SafeModelError("INVALID_PROVIDER_RESPONSE");
    }
    if (entry.id.length > MAX_PROVIDER_MODEL_ID_LENGTH) {
      throw new SafeModelError("PROVIDER_RESPONSE_TOO_LARGE");
    }
    return entry.id;
  });
}

function parseChatText(body: unknown): string {
  if (!isRecord(body) || !Array.isArray(body.choices) || body.choices.length === 0) {
    throw new SafeModelError("INVALID_PROVIDER_RESPONSE");
  }
  const choice = body.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) {
    throw new SafeModelError("INVALID_PROVIDER_RESPONSE");
  }
  const content = choice.message.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new SafeModelError("INVALID_PROVIDER_RESPONSE");
  }
  if (content.length > MAX_CHAT_REPLY_LENGTH) {
    throw new SafeModelError("PROVIDER_RESPONSE_TOO_LARGE");
  }
  return content;
}

function redactSecret(value: string, secret: string): string {
  const normalizedSecret = secret.trim();
  return normalizedSecret
    ? value.split(normalizedSecret).join("[REDACTED]")
    : value;
}

function hasControlCharacter(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
