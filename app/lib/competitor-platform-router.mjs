export const COMPETITOR_PLATFORM_ROUTES = Object.freeze([
  Object.freeze({
    id: "douyin",
    label: "抖音",
    skillId: "douyin-scraper",
    status: "ready",
    bridgeUrl: "http://127.0.0.1:8765",
    hosts: Object.freeze([
      "douyin.com",
      "v.douyin.com",
      "www.douyin.com",
      "iesdouyin.com",
    ]),
  }),
  Object.freeze({
    id: "xiaohongshu",
    label: "小红书",
    skillId: "xiaohongshu-scraper",
    status: "ready",
    bridgeUrl: "http://127.0.0.1:8766",
    hosts: Object.freeze([
      "xiaohongshu.com",
      "www.xiaohongshu.com",
      "xhslink.com",
      "www.xhslink.com",
    ]),
  }),
]);

function extractCandidateUrl(input) {
  const match = String(input ?? "").match(/https?:\/\/[^\s<>"']+/i);
  return match?.[0]?.replace(/[，。；、）)\]}]+$/u, "") ?? "";
}

function hostMatches(hostname, routeHost) {
  return hostname === routeHost || hostname.endsWith(`.${routeHost}`);
}

function classifyRoutePath(platformId, hostname, pathname) {
  const segments = pathname.split("/").filter(Boolean);
  if (platformId === "douyin") {
    if (hostname === "v.douyin.com") return { inputKindHint: "unknown", categoryHint: null };
    if (segments.includes("user")) return { inputKindHint: "account", categoryHint: "douyin-account" };
    if (segments.includes("video") || segments.includes("note")) return { inputKindHint: "content", categoryHint: "douyin-content" };
  }
  if (platformId === "xiaohongshu") {
    if (segments.includes("user") || segments.includes("profile")) return { inputKindHint: "account", categoryHint: "xhs-account" };
    if (segments.includes("explore") || segments.includes("item")) return { inputKindHint: "content", categoryHint: "xhs-note" };
  }
  return { inputKindHint: "unknown", categoryHint: null };
}

export function detectCompetitorPlatform(input) {
  const value = String(input ?? "").trim();
  if (!value) {
    return {
      kind: "empty",
      platformId: null,
      platformLabel: "等待识别",
      skillId: null,
      bridgeUrl: null,
      reportMode: "none",
      inputKindHint: "unknown",
      categoryHint: null,
      normalizedUrl: "",
      message: "粘贴竞品主页或作品链接后自动识别平台。",
    };
  }

  const candidateUrl = extractCandidateUrl(value);
  if (!candidateUrl) {
    return {
      kind: "unsupported",
      platformId: null,
      platformLabel: "未识别",
      skillId: null,
      bridgeUrl: null,
      reportMode: "none",
      inputKindHint: "unknown",
      categoryHint: null,
      normalizedUrl: "",
      message: "没有识别到有效链接，请粘贴完整的 http 或 https 地址。",
    };
  }

  let parsed;
  try {
    parsed = new URL(candidateUrl);
  } catch {
    return {
      kind: "unsupported",
      platformId: null,
      platformLabel: "未识别",
      skillId: null,
      bridgeUrl: null,
      reportMode: "none",
      inputKindHint: "unknown",
      categoryHint: null,
      normalizedUrl: "",
      message: "链接格式不完整，请重新复制平台分享链接。",
    };
  }

  const hostname = parsed.hostname.toLowerCase();
  const route = COMPETITOR_PLATFORM_ROUTES.find((candidate) =>
    candidate.hosts.some((host) => hostMatches(hostname, host)),
  );
  if (!route) {
    return {
      kind: "unsupported",
      platformId: null,
      platformLabel: "暂不支持",
      skillId: null,
      bridgeUrl: null,
      reportMode: "none",
      inputKindHint: "unknown",
      categoryHint: null,
      normalizedUrl: parsed.href,
      message: "当前仅识别抖音和小红书链接，其他平台后续接入。",
    };
  }

  if (route.status === "planned") {
    return {
      kind: "planned",
      platformId: route.id,
      platformLabel: route.label,
      skillId: route.skillId,
      bridgeUrl: route.bridgeUrl,
      reportMode: "none",
      inputKindHint: "unknown",
      categoryHint: null,
      normalizedUrl: parsed.href,
      message: `已识别${route.label}，对应抓取 Skill 尚待安装，当前不会误调用其他平台工具。`,
    };
  }

  const hints = classifyRoutePath(route.id, hostname, parsed.pathname);
  return {
    kind: "ready",
    platformId: route.id,
    platformLabel: route.label,
    skillId: route.skillId,
    bridgeUrl: route.bridgeUrl,
    reportMode: route.id === "douyin" ? "douyin-account" : "none",
    ...hints,
    normalizedUrl: parsed.href,
    message: `已识别${route.label}，将自动调用 ${route.skillId}。`,
  };
}
