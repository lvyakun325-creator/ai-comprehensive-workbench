export type CompetitorPlatformRoute = {
  id: string;
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
  normalizedUrl: string;
  message: string;
};

export const COMPETITOR_PLATFORM_ROUTES: readonly CompetitorPlatformRoute[];
export function detectCompetitorPlatform(
  input: string,
): CompetitorPlatformDetection;
