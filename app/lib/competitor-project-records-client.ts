import type {
  ProjectBundle,
  ProjectBundleCategory,
  ProjectResult,
  ProjectResultKind,
  ProjectTask,
  TaskStatus,
} from "./agent-project-records.mjs";


const RECORD_BRIDGE_ORIGIN = "http://127.0.0.1:8768";
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const TASK_ID = /^competitor-[0-9A-Za-z-]{4,120}$/u;
const ARTIFACT_ID = /^artifact-[0-9a-f]{16}$/u;
const BUNDLE_ID = /^bundle-[0-9a-f]{16}$/u;
const MAX_BUNDLE_DOWNLOAD_BYTES = 512 * 1024 * 1024;
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
  bundles: readonly ProjectBundle[];
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

export type FinalizeCompetitorBundleInput = {
  platformId: "douyin" | "xiaohongshu";
  inputKind: "account" | "content";
  category: ProjectBundleCategory;
  outputDir: string;
  primaryReportPath: string;
  explicitPaths: readonly string[];
  subjectName: string;
  itemCount: number;
};

export type CompetitorBundleDetail = {
  bundle: ProjectBundle;
  markdown: string | null;
  previewable: boolean;
};

const SAFE_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  ORIGIN_NOT_ALLOWED: "当前页面来源不能调用本地任务服务。",
  INVALID_REQUEST: "本地任务服务请求参数无效。",
  INVALID_TASK_STATE: "任务状态已变化，请刷新后重试。",
  TASK_ALREADY_EXISTS: "任务已经存在，请刷新任务列表。",
  TASK_NOT_FOUND: "任务记录不存在，请刷新后重试。",
  ARTIFACT_NOT_FOUND: "成果记录不存在，请刷新后重试。",
  BUNDLE_NOT_FOUND: "成果包记录不存在，请刷新后重试。",
  BUNDLE_MISSING: "成果包文件已被移动或删除。",
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

export async function finalizeCompetitorBundle(
  taskId: string,
  input: FinalizeCompetitorBundleInput,
  signal?: AbortSignal,
): Promise<{snapshot: CompetitorProjectSnapshot; bundle: ProjectBundle}> {
  assertTaskId(taskId);
  const body = await requestBridge(
    `/project-tasks/${taskId}/bundle`,
    jsonRequest("POST", {
      ...input,
      explicitPaths: [...input.explicitPaths],
    }, signal),
  );
  const snapshot = parseSnapshot(body);
  const bundleId = snapshot.tasks.find((task) => task.id === taskId)?.bundleId;
  const bundle = typeof bundleId === "string"
    ? snapshot.bundles.find((item) => item.id === bundleId)
    : undefined;
  if (!bundle) throw invalidResponse();
  return {snapshot, bundle};
}

export async function loadCompetitorBundleDetail(
  bundleId: string,
  signal?: AbortSignal,
): Promise<CompetitorBundleDetail> {
  assertBundleId(bundleId);
  const body = await requestBridge(
    `/project-bundles/${bundleId}`,
    {method: "GET", signal},
  );
  const record = requireRecord(body);
  if (
    record.ok !== true
    || !Array.isArray(record.artifacts)
    || !isRecord(record.task)
    || !isRecord(record.bundle)
    || !(record.markdown === null || typeof record.markdown === "string")
    || typeof record.previewable !== "boolean"
    || record.previewable !== (typeof record.markdown === "string")
  ) throw invalidResponse();
  const task = parseTask(record.task);
  const artifacts = record.artifacts.map(parseArtifact);
  const bundle = parseBundle(record.bundle, task, artifacts);
  if (bundle.id !== bundleId) throw invalidResponse();
  return {bundle, markdown: record.markdown, previewable: record.previewable};
}

export async function downloadCompetitorBundle(
  bundleId: string,
  signal?: AbortSignal,
): Promise<{filename: string; blob: Blob}> {
  assertBundleId(bundleId);
  let response: Response;
  try {
    response = await fetch(`${RECORD_BRIDGE_ORIGIN}/project-bundles/${bundleId}/download`, {
      method: "GET", cache: "no-store", credentials: "omit", redirect: "error",
      headers: {accept: "application/zip"}, signal,
    });
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) throw abortError();
    throw new CompetitorProjectRecordsClientError("BRIDGE_UNAVAILABLE", "无法连接本地任务服务，请确认 8768 服务已启动。");
  }
  if (!response.ok) {
    const body = await readBoundedDownloadErrorJson(response, signal);
    const record = isRecord(body) ? body : {};
    const code = stableErrorCode(record.error);
    throw new CompetitorProjectRecordsClientError(code, SAFE_MESSAGES[code] ?? SAFE_MESSAGES.INTERNAL_ERROR);
  }
  if (response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/zip") {
    void response.body?.cancel().catch(() => undefined);
    throw invalidResponse();
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (!Number.isSafeInteger(declaredLength) || declaredLength < 2 || declaredLength > MAX_BUNDLE_DOWNLOAD_BYTES) {
    void response.body?.cancel().catch(() => undefined);
    throw invalidResponse();
  }
  const bytes = await readBoundedBytes(response, MAX_BUNDLE_DOWNLOAD_BYTES, signal);
  if (bytes.byteLength !== declaredLength || bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw invalidResponse();
  return {
    filename: safeZipFilename(response.headers.get("content-disposition"), bundleId),
    blob: new Blob([
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    ], {type: "application/zip"}),
  };
}

export async function revealCompetitorBundle(
  bundleId: string,
  signal?: AbortSignal,
): Promise<void> {
  assertBundleId(bundleId);
  const body = await requestBridge(
    `/project-bundles/${bundleId}/reveal`,
    jsonRequest("POST", {}, signal),
  );
  const record = requireRecord(body);
  if (record.ok !== true || record.bundleId !== bundleId) throw invalidResponse();
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
  if (record.ok !== true || !Array.isArray(record.tasks) || !Array.isArray(record.artifacts) || !(record.bundles === undefined || Array.isArray(record.bundles))) {
    throw invalidResponse();
  }
  const tasks = record.tasks.map(parseTask);
  const results = record.artifacts.map(parseArtifact);
  return {
    tasks,
    results,
    bundles: (record.bundles ?? []).flatMap((item) =>
      isCompatibleLegacyBundle(item, tasks, results) ? [] : [parseSnapshotBundle(item, tasks, results)],
    ),
  };
}

async function readBoundedDownloadErrorJson(
  response: Response,
  signal?: AbortSignal | null,
): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => undefined);
    if (signal?.aborted) throw abortError();
    throw responseTooLarge();
  }
  const bytes = await readBoundedBytes(response, MAX_RESPONSE_BYTES, signal);
  if (signal?.aborted) throw abortError();
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    if (signal?.aborted) throw abortError();
    throw invalidResponse();
  }
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
    || !isTaskClassification(task)
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
    ...(task.inputKind === undefined ? {} : {inputKind: task.inputKind as ProjectTask["inputKind"]}),
    ...(task.category === undefined ? {} : {category: task.category as ProjectTask["category"]}),
    ...(task.bundleId === undefined ? {} : {bundleId: task.bundleId as ProjectTask["bundleId"]}),
  };
}

function parseSnapshotBundle(
  value: unknown,
  tasks: readonly ProjectTask[],
  artifacts: readonly ProjectResult[],
): ProjectBundle {
  const raw = requireRecord(value);
  const taskId = raw.taskId;
  if (typeof taskId !== "string") throw invalidResponse();
  const task = tasks.find((item) => item.id === taskId);
  if (!task) throw invalidResponse();
  return parseBundle(raw, task, artifacts);
}

function parseBundle(
  value: Record<string, unknown>,
  task: ProjectTask,
  artifacts: readonly ProjectResult[],
): ProjectBundle {
  const status = value.status;
  const inputKind = value.inputKind;
  const category = value.category;
  const artifactIds = value.artifactIds;
  const primaryReportPath = value.primaryReportPath;
  if (
    typeof value.id !== "string" || !BUNDLE_ID.test(value.id)
    || value.agentId !== "competitor-insight" || value.taskId !== task.id
    || typeof value.platformId !== "string" || value.platformId !== task.platformId
    || (inputKind !== "account" && inputKind !== "content")
    || !isBundleCategory(value.platformId, inputKind, category)
    || (status !== "ready" && status !== "missing" && status !== "legacy")
    || typeof value.subjectName !== "string" || !value.subjectName
    || !Number.isInteger(value.itemCount) || (value.itemCount as number) < 0
    || typeof value.rootDirectory !== "string" || !value.rootDirectory.startsWith("/")
    || !(primaryReportPath === null || typeof primaryReportPath === "string")
    || !(value.manifestPath === null || typeof value.manifestPath === "string")
    || !(value.archivePath === null || typeof value.archivePath === "string")
    || !Array.isArray(artifactIds) || !artifactIds.every((item) => typeof item === "string" && ARTIFACT_ID.test(item))
    || new Set(artifactIds).size !== artifactIds.length
    || !isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt)
    || task.bundleId !== value.id || task.status !== "completed"
  ) throw invalidResponse();
  const childArtifacts = artifacts.filter((item) => item.taskId === task.id && artifactIds.includes(item.id));
  if (childArtifacts.length !== artifactIds.length) throw invalidResponse();
  const primary = childArtifacts.find((item) => item.absolutePath === primaryReportPath);
  return {
    id: value.id, agentId: "competitor-insight", taskId: task.id,
    platformId: task.platformId as string, platformLabel: task.platformLabel ?? "",
    inputKind, category: category as ProjectBundleCategory, title: task.title,
    subjectName: value.subjectName, sourceUrl: task.sourceUrl ?? "", status,
    primaryArtifactId: primary?.id ?? null,
    manifestPath: value.manifestPath as string | null,
    archivePath: value.archivePath as string | null,
    rootDirectory: value.rootDirectory, artifactIds: artifactIds as string[],
    itemCount: value.itemCount as number, createdAt: value.createdAt,
    completedAt: value.updatedAt,
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

function isTaskClassification(task: Record<string, unknown>): boolean {
  if (task.inputKind === undefined && task.category === undefined && task.bundleId === undefined) return true;
  if (
    (task.inputKind !== "unknown" && task.inputKind !== "account" && task.inputKind !== "content")
    || !(task.bundleId === null || (typeof task.bundleId === "string" && BUNDLE_ID.test(task.bundleId)))
  ) return false;
  if (task.inputKind === "unknown") return task.category === null;
  return isBundleCategory(task.platformId, task.inputKind, task.category);
}

function isBundleCategory(
  platformId: unknown,
  inputKind: unknown,
  category: unknown,
): category is ProjectBundleCategory {
  return (
    (platformId === "douyin" && inputKind === "account" && category === "douyin-account")
    || (platformId === "douyin" && inputKind === "content" && category === "douyin-content")
    || (platformId === "xiaohongshu" && inputKind === "account" && category === "xhs-account")
    || (platformId === "xiaohongshu" && inputKind === "content" && category === "xhs-note")
  );
}

function assertTaskId(taskId: string): void {
  if (!TASK_ID.test(taskId)) throw invalidResponse();
}

function assertBundleId(bundleId: string): void {
  if (!BUNDLE_ID.test(bundleId)) throw invalidResponse();
}

async function readBoundedBytes(
  response: Response,
  limit: number,
  signal?: AbortSignal | null,
): Promise<Uint8Array> {
  if (!response.body) throw invalidResponse();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  const abortRead = () => { void reader.cancel().catch(() => undefined); };
  if (signal?.aborted) throw abortError();
  signal?.addEventListener("abort", abortRead, {once: true});
  try {
    while (true) {
      if (signal?.aborted) throw abortError();
      let done: boolean;
      let value: Uint8Array | undefined;
      try {
        ({done, value} = await reader.read());
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) throw abortError();
        throw error;
      }
      if (signal?.aborted) throw abortError();
      if (done) break;
      if (!value) throw invalidResponse();
      received += value.byteLength;
      if (received > limit) {
        void reader.cancel().catch(() => undefined);
        throw invalidResponse();
      }
      chunks.push(value);
    }
  } finally {
    signal?.removeEventListener("abort", abortRead);
    try { reader.releaseLock(); } catch { /* closed streams need no cleanup */ }
  }
  const merged = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

function safeZipFilename(contentDisposition: string | null, bundleId: string): string {
  const match = contentDisposition?.match(/filename="?([A-Za-z0-9._-]{1,128})"?/u);
  const candidate = match?.[1];
  return candidate?.toLowerCase().endsWith(".zip") ? candidate : `${bundleId}.zip`;
}

function isCompatibleLegacyBundle(
  value: unknown,
  tasks: readonly ProjectTask[],
  artifacts: readonly ProjectResult[],
): boolean {
  if (!isRecord(value) || !hasExactFields(value, LEGACY_BUNDLE_FIELDS)) return false;
  const task = typeof value.taskId === "string"
    ? tasks.find((item) => item.id === value.taskId)
    : undefined;
  if (!task || !Array.isArray(value.artifactIds) || !Array.isArray(task.artifactIds) || typeof value.rootDirectory !== "string") {
    return false;
  }
  const artifactIds = value.artifactIds;
  const taskArtifactIds = task.artifactIds;
  const rootDirectory = value.rootDirectory;
  if (
    value.id === undefined || typeof value.id !== "string" || !BUNDLE_ID.test(value.id)
    || value.agentId !== "competitor-insight" || value.taskId !== task.id
    || value.platformId !== task.platformId || (value.platformId !== "douyin" && value.platformId !== "xiaohongshu")
    || value.inputKind !== "unknown" || value.category !== null || value.status !== "legacy"
    || task.agentId !== "competitor-insight" || task.status !== "completed"
    || task.inputKind !== "unknown" || task.category !== null || task.bundleId !== value.id
    || value.subjectName !== task.title || value.itemCount !== 0
    || !isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt) || value.createdAt !== task.completedAt
    || value.manifestSha256 !== null || value.archiveSha256 !== null || value.memberIdentitySha256 !== null
    || !isLegacyBundlePaths(value, task)
    || artifactIds.length === 0
    || !artifactIds.every((item) => typeof item === "string" && ARTIFACT_ID.test(item))
    || new Set(artifactIds).size !== artifactIds.length
    || artifactIds.length !== taskArtifactIds.length
    || !artifactIds.every((item) => taskArtifactIds.includes(item))
  ) return false;
  const legacyArtifacts = artifacts.filter((item) => artifactIds.includes(item.id));
  return legacyArtifacts.length === artifactIds.length
    && legacyArtifacts.some((item) => item.absolutePath === value.primaryReportPath)
    && legacyArtifacts.every((item) => item.agentId === "competitor-insight"
      && item.taskId === task.id
      && typeof item.absolutePath === "string"
      && isLegacyBundleMemberPath(item.absolutePath, rootDirectory));
}

const LEGACY_BUNDLE_FIELDS = new Set([
  "id", "agentId", "taskId", "platformId", "inputKind", "category", "subjectName",
  "itemCount", "status", "rootDirectory", "primaryReportPath", "manifestPath", "archivePath",
  "artifactIds", "manifestSha256", "archiveSha256", "memberIdentitySha256", "createdAt", "updatedAt",
]);

function hasExactFields(value: Record<string, unknown>, fields: ReadonlySet<string>): boolean {
  const keys = Object.keys(value);
  return keys.length === fields.size && keys.every((key) => fields.has(key));
}

function isLegacyBundlePaths(value: Record<string, unknown>, task: ProjectTask): boolean {
  if (typeof value.rootDirectory !== "string" || typeof value.id !== "string") return false;
  const root = value.rootDirectory;
  const expectedSuffix = `/outputs/competitor-insight/${task.platformId}/${task.id}`;
  return isCleanAbsolutePath(root)
    && root.endsWith(expectedSuffix)
    && value.manifestPath === `${root}/${value.id}.manifest.json`
    && value.archivePath === `${root}/${value.id}.zip`
    && typeof value.primaryReportPath === "string"
    && value.primaryReportPath.endsWith(".md")
    && isLegacyBundleMemberPath(value.primaryReportPath, root);
}

function isLegacyBundleMemberPath(value: string, root: string): boolean {
  return isCleanAbsolutePath(value) && value.startsWith(`${root}/`);
}

function isCleanAbsolutePath(value: string): boolean {
  return value.startsWith("/")
    && !value.includes("\0")
    && value.split("/").slice(1).every((part) => part !== "" && part !== "." && part !== "..");
}

function stableErrorCode(value: unknown): string {
  return typeof value === "string" && Object.hasOwn(SAFE_MESSAGES, value)
    ? value
    : "INTERNAL_ERROR";
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
