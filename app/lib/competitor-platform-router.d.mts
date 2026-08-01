export type CompetitorPlatformId = "douyin" | "xiaohongshu";
export type CompetitorInputKind = "account" | "content";
export type CompetitorInputKindHint = CompetitorInputKind | "unknown";
export type CompetitorBundleCategory =
  | "douyin-account"
  | "douyin-content"
  | "xhs-account"
  | "xhs-note";

export type CompetitorPlatformRoute = {
  id: CompetitorPlatformId;
  label: string;
  skillId: string;
  status: "ready" | "planned";
  bridgeUrl: string;
  hosts: readonly string[];
};

export type CompetitorPlatformDetection = {
  kind: "empty" | "unsupported" | "planned" | "ready";
  platformId: string | null;
  platformLabel: string;
  skillId: string | null;
  bridgeUrl: string | null;
  reportMode: "douyin-account" | "none";
  inputKindHint: CompetitorInputKindHint;
  categoryHint: CompetitorBundleCategory | null;
  normalizedUrl: string;
  message: string;
};

export const COMPETITOR_PLATFORM_ROUTES: readonly CompetitorPlatformRoute[];
export function detectCompetitorPlatform(
  input: string,
): CompetitorPlatformDetection;
