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

function hasTaskOutputPath(value: string, outputDir: string): boolean {
  return value === outputDir || value.startsWith(`${outputDir}/`);
}

function expectedCategory(platformId: CompetitorPlatformId, inputKind: CompetitorInputKind): CompetitorBundleCategory {
  if (platformId === "douyin") return inputKind === "account" ? "douyin-account" : "douyin-content";
  return inputKind === "account" ? "xhs-account" : "xhs-note";
}

function parseReadyResponse(payload: unknown, route: CompetitorPlatformRoute, taskId: string): ScrapeReadyResponse {
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
  const outputDir = value.outputDir;
  if (!isAbsoluteSafePath(outputDir) || outputDir.split("/").at(-1) !== taskId) {
    throw new ScrapeClientError("SCRAPE_RESPONSE_INVALID", "抓取服务返回的任务目录无效，请重试。");
  }
  const dataPath = value.dataPath;
  const optionalPaths = [value.excelPath, value.markdownPath, value.imageDirectory];
  if (!isAbsoluteSafePath(dataPath) || !hasTaskOutputPath(dataPath, outputDir)
    || optionalPaths.some((path) => path !== null && (!isAbsoluteSafePath(path) || !hasTaskOutputPath(path, outputDir)))
    || !Array.isArray(value.explicitPaths) || value.explicitPaths.length === 0
    || value.explicitPaths.some((path) => !isAbsoluteSafePath(path) || !hasTaskOutputPath(path, outputDir))
    || !value.explicitPaths.includes(dataPath)) {
    throw new ScrapeClientError("SCRAPE_RESPONSE_INVALID", "抓取服务返回的成果路径无效，请重试。");
  }
  const itemCount = value.itemCount;
  if (typeof value.subjectName !== "string" || !value.subjectName.trim()
    || typeof itemCount !== "number" || !Number.isSafeInteger(itemCount) || itemCount < 0) {
    throw new ScrapeClientError("SCRAPE_RESPONSE_INVALID", "抓取服务返回的成果信息无效，请重试。");
  }
  return value as ScrapeReadyResponse;
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
  if (!health || typeof health !== "object" || (health as { ok?: unknown }).ok !== true) {
    throw new ScrapeClientError("SCRAPE_BRIDGE_UNAVAILABLE", "本地抓取服务未就绪，请先启动后重试。");
  }
  const payload = await fetchJson(
    `${route.bridgeUrl}/scrape`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: sourceUrl, taskId }), signal },
    "SCRAPE_REQUEST_FAILED",
    "抓取任务未完成，请检查链接后重试。",
  );
  return parseReadyResponse(payload, route, taskId);
}
