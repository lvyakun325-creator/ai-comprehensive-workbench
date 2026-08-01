import type {
  ProjectResult,
  ProjectResultKind,
  ProjectTask,
  TaskStatus,
} from "./agent-project-records.mjs";


const RECORD_BRIDGE_ORIGIN = "http://127.0.0.1:8768";
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const TASK_ID = /^competitor-[0-9A-Za-z-]{4,120}$/u;
const ARTIFACT_ID = /^artifact-[0-9a-f]{16}$/u;
const TASK_STATUSES = new Set<TaskStatus>([
  "waiting",
  "running",
  "completed",
  "failed",
  "stopped",
]);
const ARTIFACT_KINDS = new Set<ProjectResultKind>([
  "excel",
  "markdown",
  "json",
  "image-directory",
  "output-directory",
]);

export type CompetitorProjectSnapshot = {
  tasks: readonly ProjectTask[];
  results: readonly ProjectResult[];
};

export type CreateCompetitorTaskInput = {
  id: string;
  title: string;
  platformId: string;
  platformLabel: string;
  skillId: string;
  sourceUrl: string;
};

export type CompetitorTaskPatch = {
  status?: TaskStatus;
  progress?: number;
  currentStep?: string;
  errorSummary?: string | null;
};

export type RegisterCompetitorArtifactsInput = {
  outputDir: string;
  explicitPaths: readonly string[];
};

const SAFE_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  ORIGIN_NOT_ALLOWED: "当前页面来源不能调用本地任务服务。",
  INVALID_REQUEST: "本地任务服务请求参数无效。",
  INVALID_TASK_STATE: "任务状态已变化，请刷新后重试。",
  TASK_ALREADY_EXISTS: "任务已经存在，请刷新任务列表。",
  TASK_NOT_FOUND: "任务记录不存在，请刷新后重试。",
  ARTIFACT_NOT_FOUND: "成果记录不存在，请刷新后重试。",
  ARTIFACT_MISSING: "成果文件已被移动或删除。",
  PATH_NOT_ALLOWED: "成果路径不在受控目录中。",
  ARTIFACT_SCAN_FAILED: "成果目录扫描失败。",
  TOO_MANY_ARTIFACTS: "本次成果文件数量超过上限。",
  RECORD_STORE_DAMAGED: "本地任务记录需要修复，现有记录没有被覆盖。",
  REVEAL_FAILED: "无法在访达中显示该成果。",
  INTERNAL_ERROR: "本地任务服务处理失败。",
});

export class CompetitorProjectRecordsClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CompetitorProjectRecordsClientError";
  }
}

export function createCompetitorTaskId(): string {
  if (!globalThis.crypto?.randomUUID) {
    throw new CompetitorProjectRecordsClientError(
      "TASK_ID_UNAVAILABLE",
      "当前浏览器无法创建安全任务 ID。",
    );
  }
  return `competitor-${globalThis.crypto.randomUUID()}`;
}

export async function loadCompetitorProjectRecords(
  signal?: AbortSignal,
): Promise<CompetitorProjectSnapshot> {
  const body = await requestBridge(
    "/project-records?agentId=competitor-insight",
    {method: "GET", signal},
  );
  return parseSnapshot(body);
}

export async function createCompetitorTask(
  input: CreateCompetitorTaskInput,
  signal?: AbortSignal,
): Promise<ProjectTask> {
  const body = await requestBridge(
    "/project-tasks",
    jsonRequest("POST", {
      ...input,
      agentId: "competitor-insight",
      model: input.skillId,
    }, signal),
  );
  const record = requireRecord(body);
  if (record.ok !== true) throw invalidResponse();
  return parseTask(record.task);
}

export async function updateCompetitorTask(
  taskId: string,
  patch: CompetitorTaskPatch,
  signal?: AbortSignal,
): Promise<ProjectTask> {
  assertTaskId(taskId);
  const body = await requestBridge(
    `/project-tasks/${taskId}`,
    jsonRequest("PATCH", patch, signal),
  );
  const record = requireRecord(body);
  if (record.ok !== true) throw invalidResponse();
  return parseTask(record.task);
}

export async function registerCompetitorArtifacts(
  taskId: string,
  input: RegisterCompetitorArtifactsInput,
  signal?: AbortSignal,
): Promise<CompetitorProjectSnapshot> {
  assertTaskId(taskId);
  const body = await requestBridge(
    `/project-tasks/${taskId}/artifacts`,
    jsonRequest("POST", {
      outputDir: input.outputDir,
      explicitPaths: [...input.explicitPaths],
    }, signal),
  );
  return parseSnapshot(body);
}

export async function revealCompetitorArtifact(
  artifactId: string,
  signal?: AbortSignal,
): Promise<void> {
  if (!ARTIFACT_ID.test(artifactId)) throw invalidResponse();
  const body = await requestBridge(
    `/project-artifacts/${artifactId}/reveal`,
    jsonRequest("POST", {}, signal),
  );
  const record = requireRecord(body);
  if (record.ok !== true || record.artifactId !== artifactId) {
    throw invalidResponse();
  }
}

function jsonRequest(
  method: "POST" | "PATCH",
  body: object,
  signal?: AbortSignal,
): RequestInit {
  return {
    method,
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  };
}

async function requestBridge(path: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${RECORD_BRIDGE_ORIGIN}${path}`, {
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      headers: {accept: "application/json"},
      ...init,
    });
  } catch (error) {
    if (init.signal?.aborted || isAbortError(error)) throw abortError();
    throw new CompetitorProjectRecordsClientError(
      "BRIDGE_UNAVAILABLE",
      "无法连接本地任务服务，请确认 8768 服务已启动。",
    );
  }
  const body = await readBoundedJson(response, init.signal);
  if (!response.ok) {
    const record = isRecord(body) ? body : {};
    const code = typeof record.error === "string" ? record.error : "INTERNAL_ERROR";
    throw new CompetitorProjectRecordsClientError(
      code,
      SAFE_MESSAGES[code] ?? SAFE_MESSAGES.INTERNAL_ERROR,
    );
  }
  return body;
}

async function readBoundedJson(
  response: Response,
  signal?: AbortSignal | null,
): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => undefined);
    throw responseTooLarge();
  }
  if (!response.body) throw invalidResponse();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  const abortRead = () => {
    void reader.cancel().catch(() => undefined);
  };
  if (signal?.aborted) throw abortError();
  signal?.addEventListener("abort", abortRead, {once: true});
  try {
    while (true) {
      if (signal?.aborted) throw abortError();
      const {done, value} = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw responseTooLarge();
      }
      chunks.push(value);
    }
  } finally {
    signal?.removeEventListener("abort", abortRead);
    try {
      reader.releaseLock();
    } catch {
      // A closed stream does not need another cleanup action.
    }
  }
  const merged = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(merged));
  } catch {
    throw invalidResponse();
  }
}

function parseSnapshot(value: unknown): CompetitorProjectSnapshot {
  const record = requireRecord(value);
  if (record.ok !== true || !Array.isArray(record.tasks) || !Array.isArray(record.artifacts)) {
    throw invalidResponse();
  }
  return {
    tasks: record.tasks.map(parseTask),
    results: record.artifacts.map(parseArtifact),
  };
}

function parseTask(value: unknown): ProjectTask {
  const task = requireRecord(value);
  const status = task.status;
  const progress = task.progress;
  if (
    typeof task.id !== "string"
    || !TASK_ID.test(task.id)
    || task.agentId !== "competitor-insight"
    || typeof task.title !== "string"
    || typeof task.platformId !== "string"
    || typeof task.platformLabel !== "string"
    || typeof task.skillId !== "string"
    || !isSafeHttpUrl(task.sourceUrl)
    || typeof status !== "string"
    || !TASK_STATUSES.has(status as TaskStatus)
    || typeof progress !== "number"
    || !Number.isInteger(progress)
    || progress < 0
    || progress > 100
    || typeof task.currentStep !== "string"
    || typeof task.model !== "string"
    || !isTimestamp(task.createdAt)
    || !isTimestamp(task.updatedAt)
    || !isOptionalTimestamp(task.completedAt)
    || !isOptionalTimestamp(task.stoppedAt)
    || !(task.errorSummary === null || typeof task.errorSummary === "string")
    || !Array.isArray(task.artifactIds)
    || !task.artifactIds.every((item) => typeof item === "string" && ARTIFACT_ID.test(item))
  ) {
    throw invalidResponse();
  }
  return {
    id: task.id,
    agentId: "competitor-insight",
    title: task.title,
    platformId: task.platformId,
    platformLabel: task.platformLabel,
    skillId: task.skillId,
    sourceUrl: task.sourceUrl as string,
    status: status as TaskStatus,
    progress,
    currentStep: task.currentStep,
    model: task.model,
    createdAt: task.createdAt as string,
    updatedAt: task.updatedAt as string,
    completedAt: task.completedAt as string | null,
    stoppedAt: task.stoppedAt as string | null,
    errorSummary: task.errorSummary as string | null,
    artifactIds: task.artifactIds as string[],
  };
}

function parseArtifact(value: unknown): ProjectResult {
  const artifact = requireRecord(value);
  if (
    typeof artifact.id !== "string"
    || !ARTIFACT_ID.test(artifact.id)
    || artifact.agentId !== "competitor-insight"
    || typeof artifact.taskId !== "string"
    || !TASK_ID.test(artifact.taskId)
    || typeof artifact.kind !== "string"
    || !ARTIFACT_KINDS.has(artifact.kind as ProjectResultKind)
    || typeof artifact.filename !== "string"
    || !artifact.filename
    || typeof artifact.absolutePath !== "string"
    || !artifact.absolutePath.startsWith("/")
    || artifact.absolutePath.includes("\0")
    || typeof artifact.sizeBytes !== "number"
    || !Number.isSafeInteger(artifact.sizeBytes)
    || artifact.sizeBytes < 0
    || !isTimestamp(artifact.completedAt)
    || typeof artifact.previewable !== "boolean"
    || typeof artifact.exists !== "boolean"
    || typeof artifact.isDirectory !== "boolean"
    || artifact.markdown !== null
  ) {
    throw invalidResponse();
  }
  return {
    id: artifact.id,
    agentId: "competitor-insight",
    taskId: artifact.taskId,
    filename: artifact.filename,
    completedAt: artifact.completedAt as string,
    sizeBytes: artifact.sizeBytes,
    markdown: null,
    kind: artifact.kind as ProjectResultKind,
    absolutePath: artifact.absolutePath,
    exists: artifact.exists,
    isDirectory: artifact.isDirectory,
    previewable: artifact.previewable,
  };
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw invalidResponse();
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isOptionalTimestamp(value: unknown): value is string | null {
  return value === null || isTimestamp(value);
}

function isSafeHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "https:" || parsed.protocol === "http:")
      && Boolean(parsed.hostname)
      && !parsed.username
      && !parsed.password
    );
  } catch {
    return false;
  }
}

function assertTaskId(taskId: string): void {
  if (!TASK_ID.test(taskId)) throw invalidResponse();
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function abortError(): DOMException {
  return new DOMException("任务请求已取消。", "AbortError");
}

function invalidResponse(): CompetitorProjectRecordsClientError {
  return new CompetitorProjectRecordsClientError(
    "INVALID_BRIDGE_RESPONSE",
    "本地任务服务返回了无效响应。",
  );
}

function responseTooLarge(): CompetitorProjectRecordsClientError {
  return new CompetitorProjectRecordsClientError(
    "RESPONSE_TOO_LARGE",
    "本地任务记录超过浏览器读取上限。",
  );
}
