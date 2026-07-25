import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the AI workspace interface", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<html lang="zh-CN">/i);
  assert.match(html, /<title>AI 综合工作台<\/title>/i);
  assert.match(html, /AI 经营助手/);
  assert.match(html, /九大核心工作台/);
  assert.match(html, /GPT-5\.6/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/i);
});

test("contains all nine requested workbench entries and configuration UI", async () => {
  const page = await readFile(
    new URL("../app/page.tsx", import.meta.url),
    "utf8",
  );
  const styles = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );

  const expectedTools = [
    "内容矩阵设计",
    "竞品洞察",
    "选题策划",
    "标题策划",
    "新媒体图文生成器",
    "超级 AI 写作系统",
    "爆款拆解与口播生成",
    "新媒体获客视频工作台",
    "数据复盘",
  ];

  for (const tool of expectedTools) {
    assert.match(page, new RegExp(tool));
  }

  assert.match(page, /大模型配置/);
  assert.match(page, /OpenAI/);
  assert.match(page, /Anthropic/);
  assert.match(page, /Google AI/);
  assert.match(page, /DeepSeek/);
  assert.match(styles, /@media \(max-width: 720px\)/);
  assert.match(styles, /prefers-reduced-motion/);
});
