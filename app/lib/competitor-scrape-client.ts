import type {
  CompetitorBundleCategory,
  CompetitorInputKind,
  CompetitorPlatformId,
  CompetitorPlatformRoute,
} from "./competitor-platform-router.mjs";

export type ScrapeReadyResponse = {
  platformId: CompetitorPlatformId;
  skillId: "douyin-scraper" | "xiaohongshu-scraper";
  inputKind: CompetitorInputKind;
  category: CompetitorBundleCategory;
  outputDir: string;
  dataPath: string;
  excelPath: string | null;
  markdownPath: string | null;
  imageDirectory: string | null;
  explicitPaths: readonly string[];
  subjectName: string;
  itemCount: number;
};

type ScrapeClientErrorCode = "SCRAPE_BRIDGE_UNAVAILABLE" | "SCRAPE_RESPONSE_INVALID" | "SCRAPE_REQUEST_FAILED";

export class ScrapeClientError extends Error {
  readonly code: ScrapeClientErrorCode;

  constructor(code: ScrapeClientErrorCode, message: string) {
    super(message);
    this.name = "ScrapeClientError";
    this.code = code;
  }
}

const responseFields = [
  "platformId", "skillId", "inputKind", "category", "outputDir", "dataPath", "excelPath",
  "markdownPath", "imageDirectory", "explicitPaths", "subjectName", "itemCount",
] as const;

function isAbsoluteSafePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.startsWith("/") && !value.includes("\0");
}

function normalizeAbsolutePath(value: unknown): string | null {
  if (!isAbsoluteSafePath(value)) return null;
  const segments: string[] = [];
  for (const segment of value.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!segments.length) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `/${segments.join("/")}`;
}

function isStrictTaskDescendant(path: string, outputDir: string): boolean {
  const pathSegments = path.split("/").filter(Boolean);
  const outputSegments = outputDir.split("/").filter(Boolean);
  return pathSegments.length > outputSegments.length
    && outputSegments.every((segment, index) => pathSegments[index] === segment);
}

function expectedCategory(platformId: CompetitorPlatformId, inputKind: CompetitorInputKind): CompetitorBundleCategory {
  if (platformId === "douyin") return inputKind === "account" ? "douyin-account" : "douyin-content";
  return inputKind === "account" ? "xhs-account" : "xhs-note";
}

function parseReadyResponse(
  payload: unknown,
  route: CompetitorPlatformRoute,
  taskId: string,
  healthOutputRoot: string,
): ScrapeReadyResponse {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ScrapeClientError("SCRAPE_RESPONSE_INVALID", "抓取服务返回的数据不完整，请重试。");
  }
  const value = payload as Record<string, unknown>;
  if (Object.keys(value).length !== responseFields.length || responseFields.some((field) => !(field in value))) {
    throw new ScrapeClientError("SCRAPE_RESPONSE_INVALID", "抓取服务返回的数据不完整，请重试。");
  }
  if (value.platformId !== route.id || value.skillId !== route.skillId) {
    throw new ScrapeClientError("SCRAPE_RESPONSE_INVALID", "抓取服务返回的平台不匹配，请重试。");
  }
  const inputKind = value.inputKind;
  if (inputKind !== "account" && inputKind !== "content") {
    throw new ScrapeClientError("SCRAPE_RESPONSE_INVALID", "抓取服务返回的链接类型无效，请重试。");
  }
  if (value.category !== expectedCategory(route.id, inputKind)) {
    throw new ScrapeClientError("SCRAPE_RESPONSE_INVALID", "抓取服务返回的成果分类无效，请重试。");
  }
  const outputDir = normalizeAbsolutePath(value.outputDir);
  if (!outputDir || outputDir !== `${healthOutputRoot}/${taskId}`) {
    throw new ScrapeClientError("SCRAPE_RESPONSE_INVALID", "抓取服务返回的任务目录无效，请重试。");
  }
  const dataPath = normalizeAbsolutePath(value.dataPath);
  const excelPath = value.excelPath === null ? null : normalizeAbsolutePath(value.excelPath);
  const markdownPath = value.markdownPath === null ? null : normalizeAbsolutePath(value.markdownPath);
  const imageDirectory = value.imageDirectory === null ? null : normalizeAbsolutePath(value.imageDirectory);
  const explicitPaths = Array.isArray(value.explicitPaths)
    ? value.explicitPaths.map(normalizeAbsolutePath)
    : null;
  if (!dataPath || !isStrictTaskDescendant(dataPath, outputDir)
    || (value.excelPath !== null && !excelPath) || (value.markdownPath !== null && !markdownPath) || (value.imageDirectory !== null && !imageDirectory)
    || [excelPath, markdownPath, imageDirectory].some((path) => path !== null && !isStrictTaskDescendant(path, outputDir))
    || !explicitPaths || explicitPaths.length === 0 || explicitPaths.some((path) => !path || !isStrictTaskDescendant(path, outputDir))
    || !explicitPaths.includes(dataPath)) {
    throw new ScrapeClientError("SCRAPE_RESPONSE_INVALID", "抓取服务返回的成果路径无效，请重试。");
  }
  const itemCount = value.itemCount;
  if (typeof value.subjectName !== "string" || !value.subjectName.trim()
    || typeof itemCount !== "number" || !Number.isSafeInteger(itemCount) || itemCount < 0) {
    throw new ScrapeClientError("SCRAPE_RESPONSE_INVALID", "抓取服务返回的成果信息无效，请重试。");
  }
  return {
    platformId: route.id,
    skillId: route.skillId as ScrapeReadyResponse["skillId"],
    inputKind,
    category: value.category as CompetitorBundleCategory,
    outputDir,
    dataPath,
    excelPath,
    markdownPath,
    imageDirectory,
    explicitPaths: explicitPaths as string[],
    subjectName: value.subjectName.trim(),
    itemCount,
  };
}

async function fetchJson(url: string, options: RequestInit, errorCode: ScrapeClientErrorCode, message: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, options);
  } catch {
    throw new ScrapeClientError(errorCode, message);
  }
  if (!response.ok) throw new ScrapeClientError(errorCode, message);
  try {
    return await response.json();
  } catch {
    throw new ScrapeClientError(errorCode, message);
  }
}

export async function scrapeCompetitorLink(
  route: CompetitorPlatformRoute,
  sourceUrl: string,
  taskId: string,
  signal?: AbortSignal,
): Promise<ScrapeReadyResponse> {
  const health = await fetchJson(`${route.bridgeUrl}/health`, { signal }, "SCRAPE_BRIDGE_UNAVAILABLE", "本地抓取服务未就绪，请先启动后重试。");
  const healthRecord = health && typeof health === "object" && !Array.isArray(health)
    ? health as Record<string, unknown>
    : null;
  const healthOutputRoot = normalizeAbsolutePath(healthRecord?.outputDir);
  const expectedSuffix = `/outputs/competitor-insight/${route.id}`;
  if (
    healthRecord?.ok !== true
    || healthRecord.status !== "ready"
    || healthRecord.service !== route.skillId
    || !healthOutputRoot
    || !healthOutputRoot.endsWith(expectedSuffix)
  ) {
    throw new ScrapeClientError("SCRAPE_BRIDGE_UNAVAILABLE", "本地抓取服务未就绪，请先启动后重试。");
  }
  const payload = await fetchJson(
    `${route.bridgeUrl}/scrape`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: sourceUrl, taskId }), signal },
    "SCRAPE_REQUEST_FAILED",
    "抓取任务未完成，请检查链接后重试。",
  );
  return parseReadyResponse(payload, route, taskId, healthOutputRoot);
}
