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
  assert.match(html, /聊天智能体/);
  assert.match(html, /选择模型后，直接描述你想完成的事情/);
  assert.match(html, /请先添加模型/);
  assert.match(html, /发送/);
  assert.match(html, /AI 对话/);
  assert.match(html, /Agent 项目/);
  assert.match(html, /任务中心/);
  assert.match(html, /成果资产库/);
  assert.match(html, /数据概览/);
  assert.match(html, /模型配置/);
  assert.match(html, /快捷开始/);
  assert.match(html, /规划本月内容/);
  assert.match(html, /分析竞品账号/);
  assert.match(html, /复盘上周数据/);
  assert.match(html, /9 个独立 Agent 项目/);
  assert.match(html, /项目隔离已开启/);
  assert.match(html, /只会操作本项目资料/);
  assert.match(html, /进入独立项目/);
  assert.match(html, /本地工作台运行中/);
  assert.doesNotMatch(html, /本地设计预览/);
  assert.doesNotMatch(
    html,
    /总控 Agent|拆解并分配|拆解竞品账号|最大并发|子 Agent|任务调度预览|成果交接预览/,
  );
  assert.doesNotMatch(html, /全局可用模型|Agent 默认模型|密钥仅在后续接口阶段通过服务端保存/);
  assert.doesNotMatch(html, /api[_-]?key\s*[:=]/i);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/i);
});

test("keeps the shell focused on the single chat agent", async () => {
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
  const globalModelSettings = await readFile(
    new URL("../app/components/GlobalModelSettings.tsx", import.meta.url),
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
  assert.doesNotMatch(controlDesk, /总控|调度|拆解|并发|子 Agent/);
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
    /activeTab === "Agent 配置" \?\s*\(\s*<ModelConfigPanel\s+scope="agent"\s+agentId=\{agent\.id\}\s+agentTitle=\{agent\.title\}\s+onPreview=\{onPreview\}\s*\/>/,
  );
  const projectTabs = agentWorkspace
    .match(/const PROJECT_TABS = \[([\s\S]*?)\];/)?.[1]
    .match(/"[^"]+"/g)
    ?.map((tab) => tab.slice(1, -1)) ?? [];
  assert.deepEqual(projectTabs, [
    "项目总览",
    "Agent 对话",
    "任务列表",
    "成果文件",
    "Agent 配置",
  ]);
  assert.doesNotMatch(
    projectTabs.join("\n"),
    /项目资料|执行过程|成果交接/,
  );
  assert.match(modelConfigPanel, /scope: "global";/);
  assert.match(modelConfigPanel, /scope: "agent";/);
  assert.match(modelConfigPanel, /agentId: string;/);
  assert.match(modelConfigPanel, /agentTitle: string;/);
  assert.match(modelConfigPanel, /onPreview: \(message: string\) => void;/);
  assert.match(modelConfigPanel, /useModelRegistry/);
  assert.match(modelConfigPanel, /agentTitle\} · Agent 默认模型/);
  assert.match(modelConfigPanel, /return <GlobalModelSettings onPreview=\{onPreview\} \/>;/);
  assert.match(globalModelSettings, /<h1>模型设置<\/h1>/);
  assert.match(
    globalModelSettings,
    /分别填写文案模型和生图模型的 API Key、Base URL、模型名称。/,
  );
  assert.match(
    globalModelSettings,
    /浏览器本机保存不是硬件级加密，同源脚本可读取。/,
  );
  assert.match(globalModelSettings, /getMaskedCredential/);
  assert.match(globalModelSettings, /usesBrowserDirectModelRoute/);
  assert.doesNotMatch(globalModelSettings, /images\/generations/);
  for (const className of [
    "global-model-settings",
    "model-settings-header",
    "model-settings-card",
    "credential-saved-line",
    "connection-status",
    "model-settings-actions",
    "model-settings-footer",
  ]) {
    assert.match(styles, new RegExp(`\\.${className}\\s*\\{`));
  }
  const mobileStyles = styles.slice(styles.indexOf("@media (max-width: 720px)"));
  assert.match(
    mobileStyles,
    /\.model-settings-connection-fields\s*\{[^}]*grid-template-columns:\s*1fr/,
  );
  assert.match(
    mobileStyles,
    /\.model-settings-footer\s*\{[^}]*flex-direction:\s*column/,
  );
});
