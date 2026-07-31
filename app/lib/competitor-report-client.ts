const REPORT_BRIDGE_ORIGIN = "http://127.0.0.1:8767";
const MAX_EXCEL_BYTES = 50 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_PATH_CHARACTERS = 4_096;
const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export type EvidenceReadyResponse = {
  ok: true;
  stage: "evidence_ready";
  evidenceId: string;
  account: Record<string, unknown>;
  completeness: Record<string, unknown>;
  batchInputs: Record<string, unknown>;
};

export type ValidatedBatchResponse = {
  ok: true;
  stage: "section_validated";
  evidenceId: string;
  batchId: "strategy" | "performance" | "execution";
  batch: Record<string, unknown>;
};

export type ReportReadyResponse = {
  ok: true;
  stage: "report_ready";
  filename: string;
  reportPath: string;
  markdown: string;
  validationErrors: unknown[];
};

const SAFE_ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  ORIGIN_NOT_ALLOWED: "当前页面来源不能调用本地报告服务。",
  PATH_NOT_ALLOWED: "只能分析本地抖音抓取目录中的 Excel。",
  SYMLINK_NOT_ALLOWED: "不允许读取符号链接文件。",
  INTERNAL_SECURITY_BOUNDARY: "当前系统缺少安全文件读取能力。",
  INVALID_REQUEST: "报告服务请求参数无效。",
  INVALID_JSON: "报告服务请求格式无效。",
  INVALID_BASE64: "Excel 文件编码失败，请重新选择文件。",
  INVALID_WORKBOOK: "Excel 中没有可用的作品数据。",
  XLSX_ARCHIVE_TOO_LARGE: "Excel 解压规模超过安全上限。",
  EXCEL_TOO_LARGE: "Excel 文件超过 50 MB 上限。",
  REQUEST_TOO_LARGE: "Excel 传输内容超过本地桥上限。",
  INVALID_EVIDENCE_ID: "证据会话无效，请重新分析 Excel。",
  EVIDENCE_NOT_FOUND: "证据包已失效，请重新分析 Excel。",
  INVALID_EVIDENCE: "证据包校验失败，请重新分析 Excel。",
  INVALID_SECTION: "报告章节未通过证据校验。",
  INVALID_REPORT_BATCHES: "报告批次不完整，请从失败批次重试。",
  FINAL_REPORT_INVALID: "最终报告校验未通过。",
  REPORT_TOO_LARGE_FOR_PREVIEW: "报告已保存，但内容超过浏览器预览上限。",
  INTERNAL_ERROR: "本地报告服务处理失败。",
});

export class CompetitorReportClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CompetitorReportClientError";
  }
}

export async function analyzeReportPath(
  excelPath: string,
  signal: AbortSignal,
): Promise<EvidenceReadyResponse> {
  const path = excelPath.trim();
  if (!path || path.length > MAX_PATH_CHARACTERS || !/\.xlsx$/iu.test(path)) {
    throw new CompetitorReportClientError(
      "INVALID_WORKBOOK",
      "仅支持受控目录中的 .xlsx 文件。",
    );
  }
  return postReportBridge(
    "/analyze-path",
    { path },
    signal,
    parseEvidenceReady,
  );
}

export async function analyzeReportUpload(
  file: File,
  signal: AbortSignal,
): Promise<EvidenceReadyResponse> {
  if (!/\.xlsx$/iu.test(file.name)) {
    throw new CompetitorReportClientError(
      "INVALID_WORKBOOK",
      "仅支持 .xlsx 文件。",
    );
  }
  if (file.size > MAX_EXCEL_BYTES) {
    throw new CompetitorReportClientError(
      "EXCEL_TOO_LARGE",
      "Excel 文件超过 50 MB 上限。",
    );
  }
  assertNotAborted(signal);
  const bytes = new Uint8Array(await file.arrayBuffer());
  assertNotAborted(signal);
  const contentBase64 = await encodeBase64(bytes, signal);
  return postReportBridge(
    "/analyze-upload",
    { filename: file.name, contentBase64 },
    signal,
    parseEvidenceReady,
  );
}

export async function validateReportBatch(
  evidenceId: string,
  batch: unknown,
  signal: AbortSignal,
): Promise<ValidatedBatchResponse> {
  return postReportBridge(
    "/validate-section",
    { evidenceId, batch },
    signal,
    parseValidatedBatch,
  );
}

export async function assembleReport(
  evidenceId: string,
  batches: unknown[],
  signal: AbortSignal,
): Promise<ReportReadyResponse> {
  return postReportBridge(
    "/assemble-report",
    { evidenceId, batches },
    signal,
    parseReportReady,
  );
}

async function postReportBridge<T>(
  path: string,
  payload: Record<string, unknown>,
  signal: AbortSignal,
  parseSuccess: (value: unknown) => T,
): Promise<T> {
  assertNotAborted(signal);
  let response: Response;
  try {
    response = await fetch(`${REPORT_BRIDGE_ORIGIN}${path}`, {
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (error) {
    if (signal.aborted || isAbortError(error)) throw abortError();
    throw new CompetitorReportClientError(
      "BRIDGE_UNAVAILABLE",
      "无法连接本地报告服务，请确认 8767 服务已启动。",
    );
  }
  const body = await readBoundedJson(response, signal);
  if (!response.ok) throw safeBridgeError(response.status, body);
  try {
    return parseSuccess(body);
  } catch (error) {
    if (error instanceof CompetitorReportClientError) throw error;
    throw invalidResponse();
  }
}

async function readBoundedJson(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength)
    && declaredLength > MAX_RESPONSE_BYTES
  ) {
    void response.body?.cancel().catch(() => undefined);
    throw responseTooLarge();
  }
  if (!response.body) throw invalidResponse();

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let received = 0;
  try {
    while (true) {
      assertNotAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw responseTooLarge();
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Releasing a closed response stream must not replace the stable result.
    }
  }
  try {
    return JSON.parse(chunks.join(""));
  } catch {
    throw invalidResponse();
  }
}

async function encodeBase64(
  bytes: Uint8Array,
  signal: AbortSignal,
): Promise<string> {
  const chunks: string[] = [];
  const bytesPerChunk = 3 * 87_381;
  for (let offset = 0; offset < bytes.length; offset += bytesPerChunk) {
    assertNotAborted(signal);
    const end = Math.min(bytes.length, offset + bytesPerChunk);
    let encoded = "";
    for (let index = offset; index < end; index += 3) {
      const first = bytes[index] ?? 0;
      const hasSecond = index + 1 < bytes.length;
      const hasThird = index + 2 < bytes.length;
      const second = hasSecond ? bytes[index + 1] ?? 0 : 0;
      const third = hasThird ? bytes[index + 2] ?? 0 : 0;
      encoded += BASE64_ALPHABET[first >> 2];
      encoded += BASE64_ALPHABET[((first & 3) << 4) | (second >> 4)];
      encoded += hasSecond
        ? BASE64_ALPHABET[((second & 15) << 2) | (third >> 6)]
        : "=";
      encoded += hasThird ? BASE64_ALPHABET[third & 63] : "=";
    }
    chunks.push(encoded);
    if (end < bytes.length) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
  assertNotAborted(signal);
  return chunks.join("");
}

function parseEvidenceReady(value: unknown): EvidenceReadyResponse {
  const body = exactRecord(value, [
    "ok",
    "stage",
    "evidenceId",
    "account",
    "completeness",
    "batchInputs",
  ]);
  if (
    body.ok !== true
    || body.stage !== "evidence_ready"
    || typeof body.evidenceId !== "string"
    || !/^[0-9a-f]{16}$/u.test(body.evidenceId)
    || !isRecord(body.account)
    || !isRecord(body.completeness)
    || !isRecord(body.batchInputs)
  ) {
    throw invalidResponse();
  }
  return body as EvidenceReadyResponse;
}

function parseValidatedBatch(value: unknown): ValidatedBatchResponse {
  const body = exactRecord(value, [
    "ok",
    "stage",
    "evidenceId",
    "batchId",
    "batch",
  ]);
  if (
    body.ok !== true
    || body.stage !== "section_validated"
    || typeof body.evidenceId !== "string"
    || !/^[0-9a-f]{16}$/u.test(body.evidenceId)
    || !["strategy", "performance", "execution"].includes(String(body.batchId))
    || !isRecord(body.batch)
    || body.batch.batchId !== body.batchId
  ) {
    throw invalidResponse();
  }
  return body as ValidatedBatchResponse;
}

function parseReportReady(value: unknown): ReportReadyResponse {
  const body = exactRecord(value, [
    "ok",
    "stage",
    "filename",
    "reportPath",
    "markdown",
    "validationErrors",
  ]);
  if (
    body.ok !== true
    || body.stage !== "report_ready"
    || !validText(body.filename, 255)
    || !/\.md$/iu.test(body.filename)
    || !validText(body.reportPath, MAX_PATH_CHARACTERS)
    || !body.reportPath.startsWith("/")
    || !validText(body.markdown, MAX_RESPONSE_BYTES)
    || !Array.isArray(body.validationErrors)
  ) {
    throw invalidResponse();
  }
  return body as ReportReadyResponse;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!isRecord(value)) throw invalidResponse();
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw invalidResponse();
  }
  return value;
}

function safeBridgeError(status: number, value: unknown): Error {
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    if (
      keys.length === 3
      && keys[0] === "error"
      && keys[1] === "message"
      && keys[2] === "ok"
      && value.ok === false
      && typeof value.error === "string"
      && SAFE_ERROR_MESSAGES[value.error]
    ) {
      return new CompetitorReportClientError(
        value.error,
        SAFE_ERROR_MESSAGES[value.error],
      );
    }
  }
  const message = status === 413
    ? "报告服务响应超过安全上限。"
    : "本地报告服务未完成请求，请安全重试。";
  return new CompetitorReportClientError("BRIDGE_REQUEST_FAILED", message);
}

function validText(value: unknown, maxCharacters: number): value is string {
  return (
    typeof value === "string"
    && value.trim().length > 0
    && value.length <= maxCharacters
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

function invalidResponse(): CompetitorReportClientError {
  return new CompetitorReportClientError(
    "INVALID_BRIDGE_RESPONSE",
    "本地报告服务返回了无效响应。",
  );
}

function responseTooLarge(): CompetitorReportClientError {
  return new CompetitorReportClientError(
    "BRIDGE_RESPONSE_TOO_LARGE",
    "报告服务响应超过 2 MB 安全上限。",
  );
}
