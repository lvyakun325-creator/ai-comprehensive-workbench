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
  assert.match(html, /数据概览/);
  assert.match(html, /模型配置/);
  assert.match(html, /快捷开始/);
  assert.match(html, /规划本月内容/);
  assert.match(html, /拆解竞品账号/);
  assert.match(html, /复盘上周数据/);
  assert.match(html, /9 个独立 Agent 项目/);
  assert.match(html, /项目隔离已开启/);
  assert.match(html, /只会操作本项目资料/);
  assert.match(html, /进入独立项目/);
  assert.match(html, /运行中 3/);
  assert.match(html, /排队中 2/);
  assert.match(html, /待人工确认/);
  assert.match(html, /公共资产只读/);
  assert.match(html, /只读副本/);
  assert.match(html, /内容产能/);
  assert.match(html, /Agent 调用量/);
  assert.doesNotMatch(html, /全局可用模型|Agent 默认模型|密钥仅在后续接口阶段通过服务端保存/);
  assert.doesNotMatch(html, /api[_-]?key\s*[:=]/i);
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
  const controlDesk = await readFile(
    new URL("../app/components/ControlDesk.tsx", import.meta.url),
    "utf8",
  );
  const styles = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  const agentWorkspace = await readFile(
    new URL("../app/components/AgentWorkspace.tsx", import.meta.url),
    "utf8",
  );
  const modelConfigPanel = await readFile(
    new URL("../app/components/ModelConfigPanel.tsx", import.meta.url),
    "utf8",
  );

  assert.match(page, /createInitialState/);
  assert.match(page, /navigateTo/);
  assert.match(page, /openAgent/);
  assert.match(page, /系统设置将在接口与权限阶段启用/);
  assert.match(
    page,
    /if \(state\.view === "models"\) \{\s*return <ModelConfigPanel scope="global" onPreview=\{showPreview\} \/>;\s*\}/,
  );
  assert.match(shell, /const NAV_ITEMS/);
  assert.match(shell, /系统设置/);
  assert.match(controlDesk, /onClick=\{\(\) => onPreview\(/);
  assert.match(styles, /\.agent-directory\s*\{/);
  assert.match(styles, /grid-template-columns:\s*repeat\(3/);
  assert.match(styles, /\.isolation-banner\s*\{/);
  assert.match(styles, /\.task-center\s*\{/);
  assert.match(styles, /\.asset-library\s*\{/);
  assert.match(styles, /\.data-overview\s*\{/);
  assert.match(styles, /@media \(max-width: 1020px\)/);
  assert.match(styles, /@media \(max-width: 720px\)/);
  assert.match(styles, /prefers-reduced-motion/);
  assert.match(
    agentWorkspace,
    /activeTab === "Agent 配置" \?\s*\(\s*<ModelConfigPanel scope="agent" agentTitle=\{agent\.title\} onPreview=\{onPreview\} \/>/,
  );
  assert.match(modelConfigPanel, /scope: "global" \| "agent";/);
  assert.match(modelConfigPanel, /agentTitle\?: string;/);
  assert.match(modelConfigPanel, /onPreview: \(message: string\) => void;/);
  assert.match(modelConfigPanel, /useModelRegistry/);
  assert.match(modelConfigPanel, /<h2>全局可用模型<\/h2>/);
  assert.match(modelConfigPanel, /agentTitle\} · Agent 默认模型/);
  assert.match(modelConfigPanel, /className="model-config-form"/);
  assert.match(modelConfigPanel, /className="configured-model-list"/);
  assert.match(modelConfigPanel, /添加后启用/);
  assert.match(modelConfigPanel, /role="alert"/);
  assert.match(styles, /\.model-config-form\s*\{/);
  assert.match(styles, /\.configured-model-list\s*\{/);
  assert.match(styles, /\.configured-model-row\s*\{/);
  assert.match(styles, /\.model-state-actions\s*\{/);
  const props = modelConfigPanel.match(/type ModelConfigPanelProps = \{([\s\S]*?)\n\};/)?.[1] ?? "";
  assert.doesNotMatch(modelConfigPanel, /api[_-]?key|token|password|credential/i);
  assert.doesNotMatch(props, /api[_-]?key|token|password|credential/i);
});
