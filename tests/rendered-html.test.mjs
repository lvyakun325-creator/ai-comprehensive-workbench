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
  assert.match(html, /GPT-5\.6/);
  assert.match(html, /总控 Agent/);
  assert.match(html, /拆解并分配/);
  assert.match(html, /最大并发 3/);
  assert.match(html, /总控台/);
  assert.match(html, /Agent 项目/);
  assert.match(html, /任务中心/);
  assert.match(html, /成果资产库/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/i);
});

test("keeps the shell focused on the total-control preview", async () => {
  const page = await readFile(
    new URL("../app/page.tsx", import.meta.url),
    "utf8",
  );
  const shell = await readFile(
    new URL("../app/components/WorkbenchShell.tsx", import.meta.url),
    "utf8",
  );
  const styles = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );

  assert.match(page, /createInitialState/);
  assert.match(page, /navigateTo/);
  assert.match(page, /openAgent/);
  assert.match(page, /系统设置将在接口与权限阶段启用/);
  assert.match(shell, /const NAV_ITEMS/);
  assert.match(shell, /系统设置/);
  assert.match(styles, /@media \(max-width: 720px\)/);
  assert.match(styles, /prefers-reduced-motion/);
});
