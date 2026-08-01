import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPETITOR_PLATFORM_ROUTES,
  detectCompetitorPlatform,
} from "../app/lib/competitor-platform-router.mjs";

test("routes Douyin share text to the installed Douyin scraper", () => {
  const result = detectCompetitorPlatform(
    "复制打开抖音 https://v.douyin.com/abc123/ 看看这个账号",
  );
  assert.equal(result.kind, "ready");
  assert.equal(result.platformId, "douyin");
  assert.equal(result.skillId, "douyin-scraper");
  assert.equal(result.reportMode, "douyin-account");
  assert.match(result.normalizedUrl, /^https:\/\/v\.douyin\.com\/abc123\//);
});

test("routes Xiaohongshu to the installed Xiaohongshu scraper", () => {
  const result = detectCompetitorPlatform(
    "https://www.xiaohongshu.com/explore/123456",
  );
  assert.equal(result.kind, "ready");
  assert.equal(result.platformId, "xiaohongshu");
  assert.equal(result.skillId, "xiaohongshu-scraper");
  assert.equal(result.bridgeUrl, "http://127.0.0.1:8766");
  assert.equal(result.reportMode, "none");
  assert.match(result.message, /自动调用/);
});

test("keeps unsupported links outside every platform scraper", () => {
  const result = detectCompetitorPlatform("https://example.com/competitor");
  assert.equal(result.kind, "unsupported");
  assert.equal(result.skillId, null);
  assert.equal(result.reportMode, "none");
});

test("keeps empty inputs outside every report workflow", () => {
  const result = detectCompetitorPlatform("");
  assert.equal(result.kind, "empty");
  assert.equal(result.reportMode, "none");
});

test("declares both platform routes ready", () => {
  assert.deepEqual(
    COMPETITOR_PLATFORM_ROUTES.map(({ id, status }) => ({ id, status })),
    [
      { id: "douyin", status: "ready" },
      { id: "xiaohongshu", status: "ready" },
    ],
  );
});

test("classifies clear account and content paths while short links stay unknown", () => {
  assert.equal(
    detectCompetitorPlatform("https://www.douyin.com/user/a").inputKindHint,
    "account",
  );
  assert.equal(
    detectCompetitorPlatform("https://www.douyin.com/video/1").inputKindHint,
    "content",
  );
  assert.equal(
    detectCompetitorPlatform("https://www.xiaohongshu.com/user/profile/a").categoryHint,
    "xhs-account",
  );
  assert.equal(
    detectCompetitorPlatform("https://www.xiaohongshu.com/explore/1").categoryHint,
    "xhs-note",
  );
  assert.equal(
    detectCompetitorPlatform("https://v.douyin.com/abc/").inputKindHint,
    "unknown",
  );
});
