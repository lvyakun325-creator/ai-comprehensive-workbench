const REPORT_BRIDGE_ORIGIN = "http://127.0.0.1:8768";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_PATH_CHARACTERS = 4_096;
const MAX_BATCH_INPUT_CHARACTERS = 80_000;

export type AnalyzeScrapeArtifactsInput = {
  taskId: string;
  platformId: "douyin" | "xiaohongshu";
  inputKind: "account" | "content";
  outputDir: string;
  dataPath: string;
  excelPath: string | null;
};

export type EvidenceReadyResponse = {
  ok: true;
  stage: "evidence_ready";
  evidenceId: string;
  platformId: AnalyzeScrapeArtifactsInput["platformId"];
  inputKind: AnalyzeScrapeArtifactsInput["inputKind"];
  reportType: "douyin-account" | "douyin-content" | "xhs-account" | "xhs-note";
  outputDir: string;
  subjectName: string;
  itemCount: number;
  batchInputs: Record<string, Record<string, unknown>>;
};

export type ValidatedBatchResponse = {
  ok: true;
  stage: "section_validated";
  evidenceId: string;
  batchId: "strategy" | "performance" | "execution" | "content";
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

export async function analyzeScrapeArtifacts(
  input: AnalyzeScrapeArtifactsInput,
  signal: AbortSignal = new AbortController().signal,
): Promise<EvidenceReadyResponse> {
  if (!validArtifactInput(input)) {
    throw new CompetitorReportClientError("INVALID_REQUEST", "抓取成果路径无效。");
  }
  return postReportBridge(
    "/analyze-artifacts",
    input,
    signal,
    parseEvidenceReady,
  );
}

export async function validateReportBatch(
  evidenceId: string,
  outputDir: string,
  batch: unknown,
  signal: AbortSignal,
): Promise<ValidatedBatchResponse> {
  return postReportBridge(
    "/validate-section",
    { evidenceId, outputDir, batch },
    signal,
    parseValidatedBatch,
  );
}

export async function assembleReport(
  evidenceId: string,
  outputDir: string,
  batches: unknown[],
  signal: AbortSignal,
): Promise<ReportReadyResponse> {
  return postReportBridge(
    "/assemble-report",
    { evidenceId, outputDir, batches },
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
  await verifyReportBridgeHealth(signal);
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
      "无法连接本地报告服务，请确认 8768 服务已启动。",
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

async function verifyReportBridgeHealth(signal: AbortSignal): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${REPORT_BRIDGE_ORIGIN}/health`, {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      headers: {accept: "application/json"},
      signal,
    });
  } catch (error) {
    if (signal.aborted || isAbortError(error)) throw abortError();
    throw new CompetitorReportClientError(
      "BRIDGE_UNAVAILABLE",
      "无法连接本地报告服务，请确认 8768 服务已启动。",
    );
  }
  const body = await readBoundedJson(response, signal);
  if (
    !response.ok
    || !body
    || typeof body !== "object"
    || Array.isArray(body)
    || (body as Record<string, unknown>).ok !== true
    || (body as Record<string, unknown>).stage !== "healthy"
    || (body as Record<string, unknown>).service !== "competitor-insight-report"
  ) {
    throw new CompetitorReportClientError(
      "BRIDGE_UNAVAILABLE",
      "无法确认本地报告服务身份，请检查 8768 端口后重试。",
    );
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
  let rejectAbort!: (reason: DOMException) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const abortRead = () => {
    rejectAbort(abortError());
    try {
      void reader.cancel().catch(() => undefined);
    } catch {
      // Cleanup failure must not replace the stable abort result.
    }
  };
  if (signal.aborted) abortRead();
  else signal.addEventListener("abort", abortRead, { once: true });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
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
    signal.removeEventListener("abort", abortRead);
    try {
      reader.releaseLock();
    } catch {
      // Releasing a closed response stream must not replace the stable result.
    }
  }
  if (signal.aborted) throw abortError();
  try {
    return JSON.parse(chunks.join(""));
  } catch {
    throw invalidResponse();
  }
}

function parseEvidenceReady(value: unknown): EvidenceReadyResponse {
  const body = exactRecord(value, [
    "ok",
    "stage",
    "evidenceId",
    "platformId",
    "inputKind",
    "reportType",
    "outputDir",
    "subjectName",
    "itemCount",
    "account",
    "completeness",
    "batchInputs",
  ]);
  if (
    body.ok !== true
    || body.stage !== "evidence_ready"
    || typeof body.evidenceId !== "string"
    || !/^[0-9a-f]{16}$/u.test(body.evidenceId)
    || (body.platformId !== "douyin" && body.platformId !== "xiaohongshu")
    || (body.inputKind !== "account" && body.inputKind !== "content")
    || !validReportType(body.platformId, body.inputKind, body.reportType)
    || !validText(body.outputDir, MAX_PATH_CHARACTERS)
    || !validText(body.subjectName, 200)
    || typeof body.itemCount !== "number"
    || !Number.isSafeInteger(body.itemCount)
    || body.itemCount < 1
    || !validAccount(body.account)
    || !isRecord(body.completeness)
    || !validBatchInputs(body.batchInputs, body.platformId)
  ) {
    throw invalidResponse();
  }
  return body as EvidenceReadyResponse;
}

function validBatchInputs(value: unknown, platformId: unknown): value is EvidenceReadyResponse["batchInputs"] {
  if (!isRecord(value)) return false;
  const batchIds = Object.keys(value);
  const account = hasExactKeys(value, ["strategy", "performance", "execution"]);
  const content = hasExactKeys(value, ["content"]);
  if (!account && !content) return false;
  if (!hasExactKeys(value, batchIds)) return false;
  try {
    if (JSON.stringify(value).length > MAX_BATCH_INPUT_CHARACTERS) return false;
  } catch {
    return false;
  }
  return batchIds.every((batchId) => validBatchInput(batchId, value[batchId], platformId));
}

function validBatchInput(
  batchId: string,
  value: unknown,
  platformId: unknown,
): boolean {
  if (!isRecord(value)) return false;
  const expectedKeys = batchId === "strategy"
    ? ["batchId", "allowedEvidenceIds", "account", "availability", "evidence", "rankings"]
    : batchId === "performance"
      ? ["batchId", "allowedEvidenceIds", "availability", "evidence", "metrics", "rankings"]
      : batchId === "execution"
        ? ["batchId", "allowedEvidenceIds", "availability", "evidence", "rankings"]
        : ["batchId", "allowedEvidenceIds", "author", "content", "evidence"];
  if (!hasExactKeys(value, expectedKeys) || value.batchId !== batchId || !validAllowedEvidenceIds(value.allowedEvidenceIds, platformId)) return false;
  if (batchId === "content") {
    return validEvidenceItems(value.evidence)
      && validEvidenceIdsMatch(value.evidence, value.allowedEvidenceIds, platformId)
      && isRecord(value.author)
      && isRecord(value.content);
  }
  if (!validAvailability(value.availability)) return false;
  if (batchId === "strategy" && !validAccount(value.account)) return false;
  const evidenceIds = validEvidenceIdSet(value.evidence);
  if (
    !evidenceIds
    || !validRankings(
      batchId as "strategy" | "performance" | "execution",
      value.rankings,
      evidenceIds,
      value.availability as Record<string, boolean>,
      platformId,
    )
  ) {
    return false;
  }
  return batchId !== "performance" || validMetrics(value.metrics);
}

function validAllowedEvidenceIds(value: unknown, platformId: unknown): value is string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.length <= 30
    && value.every((id) => validPlatformEvidenceId(id, platformId))
    && new Set(value).size === value.length;
}

function validEvidenceIdsMatch(evidence: unknown, allowed: unknown, platformId: unknown): boolean {
  if (!validEvidenceItems(evidence) || !validAllowedEvidenceIds(allowed, platformId)) return false;
  const ids = (evidence as Array<Record<string, unknown>>).map((item) => item.evidenceId);
  return ids.length === allowed.length && ids.every((id, index) => validPlatformEvidenceId(id, platformId) && id === allowed[index]);
}

function validReportType(platformId: unknown, inputKind: unknown, reportType: unknown): boolean {
  const expected = `${platformId === "xiaohongshu" ? "xhs" : "douyin"}-${inputKind === "content" && platformId === "xiaohongshu" ? "note" : inputKind}`;
  return reportType === expected;
}

function validArtifactInput(input: AnalyzeScrapeArtifactsInput): boolean {
  if (!isRecord(input) || !/^competitor-[0-9A-Za-z-]{4,120}$/u.test(input.taskId)) return false;
  if (input.platformId !== "douyin" && input.platformId !== "xiaohongshu") return false;
  if (input.inputKind !== "account" && input.inputKind !== "content") return false;
  const paths = [input.outputDir, input.dataPath, ...(input.excelPath === null ? [] : [input.excelPath])];
  return paths.every((path) => validText(path, MAX_PATH_CHARACTERS) && !path.includes("\0"));
}

function validAccount(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const allowed = ["accountId", "followers", "nickname", "signature"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) return false;
  const nickname = value.nickname;
  const accountId = value.accountId;
  if (
    nickname !== undefined
    && (typeof nickname !== "string" || !nickname.trim() || nickname.length > 200)
  ) return false;
  if (
    accountId !== undefined
    && (typeof accountId !== "string" || !accountId.trim() || accountId.length > 256)
  ) return false;
  if (nickname === undefined && accountId === undefined) return false;
  if (
    value.followers !== undefined
    && (
      typeof value.followers !== "number"
      || !Number.isSafeInteger(value.followers)
      || value.followers < 0
    )
  ) return false;
  return value.signature === undefined || (
    typeof value.signature === "string"
    && Boolean(value.signature.trim())
    && value.signature.length <= 1000
  );
}

function sameAccount(left: unknown, right: unknown): boolean {
  if (!validAccount(left) || !validAccount(right)) return false;
  const leftAccount = left as Record<string, unknown>;
  const rightAccount = right as Record<string, unknown>;
  const keys = ["accountId", "followers", "nickname", "signature"];
  return keys.every((key) => leftAccount[key] === rightAccount[key]);
}

function validAvailability(value: unknown): boolean {
  return (
    isRecord(value)
    && hasExactKeys(value, ["comments", "collects", "shares"])
    && [value.comments, value.collects, value.shares]
      .every((item) => typeof item === "boolean")
  );
}

function validRankings(
  batchId: "strategy" | "performance" | "execution",
  value: unknown,
  batchEvidenceIds: ReadonlySet<string>,
  availability: Readonly<Record<string, boolean>>,
  platformId: unknown,
): boolean {
  if (!isRecord(value)) return false;
  const expected = batchId === "strategy"
    ? ["overall", "startup"]
    : batchId === "performance"
      ? ["overall", "startup", "collect", "share", "comment"]
      : ["overall", "collect", "share", "comment"];
  if (!hasExactKeys(value, expected)) return false;
  return expected.every((name) => {
    const ranking = value[name];
    if (
      !isRecord(ranking)
      || !hasExactKeys(ranking, ["status", "evidenceIds"])
      || (ranking.status !== "available" && ranking.status !== "unavailable")
      || !Array.isArray(ranking.evidenceIds)
      || ranking.evidenceIds.length > 10
      || !ranking.evidenceIds.every((id) => validPlatformEvidenceId(id, platformId))
    ) {
      return false;
    }
    const ids = ranking.evidenceIds as string[];
    if (
      new Set(ids).size !== ids.length
      || ids.some((id) => !batchEvidenceIds.has(id))
    ) {
      return false;
    }
    if (name === "overall") {
      return ranking.status === "available" && ids.length > 0;
    }
    if (name === "startup") {
      return ranking.status === "available";
    }
    const availabilityKey = name === "collect"
      ? "collects"
      : name === "share"
        ? "shares"
        : "comments";
    const expectedStatus = availability[availabilityKey]
      ? "available"
      : "unavailable";
    if (ranking.status !== expectedStatus) return false;
    return ranking.status === "available" ? ids.length > 0 : ids.length === 0;
  });
}

function validEvidenceIdSet(value: unknown): ReadonlySet<string> | null {
  if (!validEvidenceItems(value)) return null;
  const items = value as Array<Record<string, unknown>>;
  const ids = items.map((item) => item.evidenceId as string);
  const uniqueIds = new Set(ids);
  return uniqueIds.size === ids.length ? uniqueIds : null;
}

function validEvidenceItems(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0 || value.length > 30) {
    return false;
  }
  const keys = [
    "evidenceId",
    "title",
    "likes",
    "comments",
    "collects",
    "shares",
    "totalInteractions",
    "publishedAt",
  ];
  return value.every((item) => (
    isRecord(item)
    && hasExactKeys(item, keys)
    && validEvidenceId(item.evidenceId)
    && typeof item.title === "string"
    && item.title.length <= 500
    && typeof item.publishedAt === "string"
    && item.publishedAt.length <= 64
    && [
      item.likes,
      item.comments,
      item.collects,
      item.shares,
      item.totalInteractions,
    ].every((metric) => (
      typeof metric === "number"
      && Number.isSafeInteger(metric)
      && metric >= 0
    ))
  ));
}

function validMetrics(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const keys = [
    "workCount",
    "averageLikes",
    "averageComments",
    "averageCollects",
    "averageShares",
    "averageInteractions",
    "maxInteractions",
    "aboveAverageInteractionCount",
    "top10InteractionShare",
    "maxToAverageMultiple",
  ];
  return (
    hasExactKeys(value, keys)
    && keys.every((key) => (
      value[key] === null
      || (typeof value[key] === "number" && Number.isFinite(value[key]))
    ))
  );
}

function validEvidenceId(value: unknown): value is string {
  return typeof value === "string" && /^(?:DY|XHS)-E\d{4,8}$/u.test(value);
}

function validPlatformEvidenceId(value: unknown, platformId: unknown): value is string {
  const prefix = platformId === "xiaohongshu" ? "XHS" : platformId === "douyin" ? "DY" : "";
  return typeof value === "string" && new RegExp(`^${prefix}-E\\d{4,8}$`, "u").test(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length
    && actual.every((key, index) => key === expected[index])
  );
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
    || !["strategy", "performance", "execution", "content"].includes(String(body.batchId))
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
