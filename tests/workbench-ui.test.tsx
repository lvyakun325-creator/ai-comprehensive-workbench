import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import { JSDOM } from "jsdom";
import type {
  ProjectResult,
  ProjectTask,
  TaskStatusFilter,
} from "../app/lib/agent-project-records.mjs";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
});

Object.defineProperties(globalThis, {
  window: { configurable: true, value: dom.window },
  document: { configurable: true, value: dom.window.document },
  navigator: { configurable: true, value: dom.window.navigator },
  HTMLElement: { configurable: true, value: dom.window.HTMLElement },
  Node: { configurable: true, value: dom.window.Node },
  MutationObserver: { configurable: true, value: dom.window.MutationObserver },
  getComputedStyle: {
    configurable: true,
    value: dom.window.getComputedStyle.bind(dom.window),
  },
  IS_REACT_ACT_ENVIRONMENT: {
    configurable: true,
    value: true,
    writable: true,
  },
});

Object.defineProperty(dom.window, "setTimeout", {
  configurable: true,
  value: () => 1,
});

Object.assign(navigator, {
  clipboard: { writeText: async (value: string) => value },
});
Object.defineProperty(URL, "createObjectURL", {
  configurable: true,
  value: () => "blob:test",
});
Object.defineProperty(URL, "revokeObjectURL", {
  configurable: true,
  value: () => undefined,
});

const { cleanup, render, screen } = await import("@testing-library/react");
const { default: userEvent } = await import("@testing-library/user-event");
const { useState } = await import("react");
const { AGENT_PROJECTS } = await import("../app/lib/agent-catalog.mjs");
const { AgentResultFiles } = await import("../app/components/AgentResultFiles");
const { AgentTaskList } = await import("../app/components/AgentTaskList");
const { default: Home } = await import("../app/page");

type TaskHistoryHarnessProps = {
  onOpenResult?: (taskId: string) => void;
  taskQuery?: (
    agentId: string,
    filter: TaskStatusFilter,
  ) => readonly ProjectTask[];
  resultQuery?: (taskId: string) => readonly ProjectResult[];
};

function TaskHistoryHarness({
  onOpenResult = () => undefined,
  taskQuery,
  resultQuery,
}: TaskHistoryHarnessProps = {}) {
  const [filter, setFilter] = useState<TaskStatusFilter>("all");

  return (
    <AgentTaskList
      agentId="content-matrix"
      filter={filter}
      getAgentTasks={taskQuery}
      getTaskResults={resultQuery}
      onFilterChange={setFilter}
      onOpenResult={onOpenResult}
    />
  );
}

const taskStateFixtures: readonly ProjectTask[] = [
  {
    id: "fixture-waiting",
    agentId: "content-matrix",
    title: "等待执行任务",
    status: "waiting",
    progress: 0,
    currentStep: "等待可用执行槽位",
    model: "gpt-5.6",
    createdAt: "2026-07-28T04:00:00.000Z",
    updatedAt: "2026-07-28T04:00:00.000Z",
    completedAt: null,
    stoppedAt: null,
    errorSummary: null,
  },
  {
    id: "fixture-failed",
    agentId: "content-matrix",
    title: "执行失败任务",
    status: "failed",
    progress: 42,
    currentStep: "生成平台内容策略",
    model: "gpt-5.6",
    createdAt: "2026-07-28T03:00:00.000Z",
    updatedAt: "2026-07-28T03:30:00.000Z",
    completedAt: null,
    stoppedAt: null,
    errorSummary: "模型连接超时，请检查配置后重试",
  },
  {
    id: "fixture-stopped",
    agentId: "content-matrix",
    title: "已停止任务",
    status: "stopped",
    progress: 26,
    currentStep: "已由用户停止",
    model: "gpt-5.6",
    createdAt: "2026-07-28T02:00:00.000Z",
    updatedAt: "2026-07-28T02:20:00.000Z",
    completedAt: null,
    stoppedAt: "2026-07-28T02:20:00.000Z",
    errorSummary: null,
  },
];

const resultFileFixtures: readonly ProjectResult[] = [
  {
    id: "fixture-markdown-result",
    agentId: "content-matrix",
    taskId: "fixture-completed",
    filename: "内容矩阵成果.md",
    completedAt: "2026-07-28T05:00:00.000Z",
    sizeBytes: 52,
    markdown: "# 内容矩阵成果\n\n这是只读的 Markdown 成果。",
  },
  {
    id: "fixture-text-result",
    agentId: "content-matrix",
    taskId: "fixture-completed",
    filename: "内部过程.txt",
    completedAt: "2026-07-28T04:59:00.000Z",
    sizeBytes: 18,
    markdown: "这个非 Markdown 文件不应出现。",
  },
];

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  window.localStorage.clear();
});

test("Markdown result lists only MD files and opens a read-only preview", async () => {
  const user = userEvent.setup({ document });
  const previewMessages: string[] = [];

  render(
    <AgentResultFiles
      agentId="content-matrix"
      getAgentResults={() => resultFileFixtures}
      initialTaskId={null}
      onPreview={(message) => previewMessages.push(message)}
    />,
  );

  assert.ok(screen.getByText("内容矩阵成果.md"));
  assert.equal(screen.queryByText("内部过程.txt"), null);

  await user.click(screen.getByRole("button", { name: /查看内容矩阵成果\.md/ }));

  const dialog = screen.getByRole("dialog", { name: "内容矩阵成果.md" });
  assert.match(dialog.textContent ?? "", /这是只读的 Markdown 成果/);
  assert.equal(screen.queryByRole("textbox"), null);
  assert.equal(dialog.querySelector("[contenteditable]"), null);
  assert.equal(screen.queryByRole("button", { name: /编辑/ }), null);
  assert.ok(screen.getByRole("button", { name: "复制内容" }));
  assert.ok(screen.getByRole("button", { name: "下载 MD" }));

  await user.click(screen.getByRole("button", { name: "复制内容" }));
  assert.deepEqual(previewMessages, ["Markdown 内容已复制"]);

  await user.click(screen.getByRole("button", { name: "关闭预览" }));
  assert.equal(screen.queryByRole("dialog"), null);
});

test("five project tabs connect task history to its Markdown result and preserve the filter", async () => {
  const user = userEvent.setup({ document });
  render(<Home />);

  await user.click(
    screen.getByRole("button", { name: /内容矩阵 Agent/ }),
  );

  const navigation = screen.getByRole("navigation", {
    name: "内容矩阵 Agent 项目导航",
  });
  assert.ok(
    screen.getByText("已完成的 Markdown 文档会保存在成果文件中。"),
  );
  const tabNames = Array.from(
    navigation.querySelectorAll("button"),
    (button) => button.textContent,
  );

  assert.deepEqual(tabNames, [
    "项目总览",
    "Agent 对话",
    "任务列表",
    "成果文件",
    "Agent 配置",
  ]);
  for (const removedTab of ["项目资料", "执行过程", "成果交接"]) {
    assert.equal(tabNames.includes(removedTab), false);
  }

  await user.click(screen.getByRole("button", { name: "任务列表" }));
  assert.equal(
    screen.queryByText("任务列表将在真实 Agent 接入后启用"),
    null,
  );
  await user.click(screen.getByRole("button", { name: "已完成" }));
  assert.equal(screen.queryByText("7 月健康内容矩阵规划"), null);
  assert.ok(screen.getByText("慢病管理内容矩阵初版"));

  await user.click(screen.getByRole("button", { name: "查看成果" }));

  assert.equal(
    screen.getByRole("button", { name: "成果文件" }).getAttribute("aria-current"),
    "page",
  );
  const dialog = screen.getByRole("dialog", {
    name: "慢病管理内容矩阵初版.md",
  });
  assert.match(dialog.textContent ?? "", /# 内容矩阵方案/);
  assert.equal(
    screen.queryByText("成果文件将在真实 Agent 接入后启用"),
    null,
  );

  await user.click(screen.getByRole("button", { name: "关闭预览" }));
  await user.click(screen.getByRole("button", { name: "任务列表" }));

  assert.equal(
    screen.getByRole("button", { name: "已完成" }).getAttribute("aria-pressed"),
    "true",
  );
  assert.equal(screen.queryByText("7 月健康内容矩阵规划"), null);
  assert.ok(screen.getByText("慢病管理内容矩阵初版"));

  await user.click(screen.getByRole("button", { name: "成果文件" }));
  assert.equal(
    screen.queryByText("成果文件将在真实 Agent 接入后启用"),
    null,
  );
});

test("task history renders progress and filters completed results", async () => {
  const user = userEvent.setup({ document });
  let openedTaskId: string | null = null;
  render(
    <TaskHistoryHarness
      onOpenResult={(taskId) => {
        openedTaskId = taskId;
      }}
    />,
  );

  assert.ok(screen.getByRole("heading", { name: "任务列表" }));
  assert.ok(screen.getAllByText("进行中").length > 0);
  assert.ok(screen.getAllByText(/当前步骤：/).length > 0);
  const progressbar = screen.getByRole("progressbar");
  assert.equal(progressbar.getAttribute("aria-valuemin"), "0");
  assert.equal(progressbar.getAttribute("aria-valuemax"), "100");
  assert.equal(progressbar.getAttribute("aria-valuenow"), "68");
  await user.click(screen.getByRole("button", { name: "查看成果" }));
  assert.equal(openedTaskId, "matrix-completed");

  await user.click(screen.getByRole("button", { name: "已完成" }));

  assert.equal(screen.queryByText("7 月健康内容矩阵规划"), null);
  assert.ok(screen.getByText("慢病管理内容矩阵初版"));
});

test("task history renders waiting failed and stopped cards with an error summary", () => {
  const taskQuery = (_agentId: string, filter: TaskStatusFilter) =>
    taskStateFixtures.filter(
      (task) => filter === "all" || task.status === filter,
    );

  render(
    <TaskHistoryHarness
      resultQuery={() => []}
      taskQuery={taskQuery}
    />,
  );

  assert.ok(screen.getByRole("heading", { name: "等待执行任务" }));
  assert.ok(screen.getByRole("heading", { name: "执行失败任务" }));
  assert.ok(screen.getByRole("heading", { name: "已停止任务" }));
  assert.ok(screen.getAllByText("等待中").length > 0);
  assert.ok(screen.getAllByText("失败").length > 0);
  assert.ok(screen.getAllByText("已停止").length > 0);
  assert.match(
    screen.getByText(/错误摘要：/).parentElement?.textContent ?? "",
    /模型连接超时，请检查配置后重试/,
  );
});

test("task history mobile CSS keeps voice input visible without toolbar overflow", () => {
  const css = readFileSync(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  const mobileStyles = css.slice(css.indexOf("@media (max-width: 720px)"));

  assert.doesNotMatch(
    mobileStyles,
    /[^{}]*\.voice-button[^{}]*\{[^{}]*display:\s*none/,
  );
  assert.match(
    mobileStyles,
    /\.chat-toolbar\s*\{[^}]*flex-wrap:\s*wrap[^}]*\}/,
  );
  assert.match(
    mobileStyles,
    /\.send-actions\s*\{[^}]*min-width:\s*0[^}]*\}/,
  );
});

test("opens all nine Agent cards and keeps Agent project navigation active", async () => {
  const user = userEvent.setup({ document });
  render(<Home />);

  for (const agent of AGENT_PROJECTS) {
    await user.click(screen.getByRole("button", { name: new RegExp(agent.title) }));

    assert.ok(screen.getByRole("heading", { name: agent.title }));
    assert.match(
      screen.getByText(new RegExp(`当前位于「${agent.title}」`)).textContent ?? "",
      /只会操作当前项目，不会修改其他 Agent 项目/,
    );
    assert.ok(
      screen.getByRole("navigation", { name: `${agent.title} 项目导航` }),
    );
    assert.equal(
      screen.getByRole("button", { name: "Agent 项目" }).getAttribute("aria-current"),
      "page",
    );

    await user.click(screen.getByRole("button", { name: "← 返回 Agent 项目" }));
  }
});

test("switches primary views and keeps system settings in the mobile navigation", async () => {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 390,
  });
  const user = userEvent.setup({ document });
  render(<Home />);

  const views = [
    ["任务中心", "任务中心"],
    ["成果资产库", "成果资产库"],
    ["数据概览", "数据概览"],
    ["模型配置", "全局可用模型"],
    ["AI 对话", "今天想聊什么，或推进什么任务？"],
    ["Agent 项目", "9 个独立 Agent 项目"],
  ] as const;

  for (const [navigationLabel, heading] of views) {
    await user.click(screen.getByRole("button", { name: navigationLabel }));
    assert.ok(screen.getByRole("heading", { name: heading }));
  }

  const primaryNavigation = screen.getByRole("navigation", { name: "主导航" });
  const settingsButton = screen.getByRole("button", { name: "系统设置" });
  assert.equal(primaryNavigation.contains(settingsButton), true);
  await user.click(settingsButton);
  assert.ok(screen.getByRole("heading", { name: "系统设置" }));
});

test("model configuration adds an enabled model and rejects duplicate provider model IDs", async () => {
  const user = userEvent.setup({ document });
  render(<Home />);

  await user.click(screen.getByRole("button", { name: "模型配置" }));
  await user.type(screen.getByLabelText("服务商"), "Anthropic");
  await user.type(screen.getByLabelText("模型显示名称"), "Claude Sonnet");
  await user.type(screen.getByLabelText("模型 ID"), "claude-sonnet");
  await user.click(screen.getByRole("checkbox", { name: "添加后启用" }));
  await user.click(screen.getByRole("button", { name: "添加模型" }));
  assert.ok(screen.getByText("Claude Sonnet"));
  assert.ok(
    screen.getByRole("button", {
      name: "设为默认 Claude Sonnet（Anthropic · claude-sonnet）",
    }),
  );

  await user.type(screen.getByLabelText("服务商"), "Anthropic");
  await user.type(screen.getByLabelText("模型显示名称"), "Claude Sonnet 副本");
  await user.type(screen.getByLabelText("模型 ID"), "claude-sonnet");
  await user.click(screen.getByRole("button", { name: "添加模型" }));
  assert.match(screen.getByRole("alert").textContent ?? "", /已存在/);

  await user.click(screen.getByRole("button", { name: "停用 Claude Sonnet" }));
  assert.match(
    screen.getByRole("list", { name: "已配置模型" }).textContent ?? "",
    /Claude Sonnet.*已停用/,
  );

  await user.click(screen.getByRole("button", { name: "Agent 项目" }));
  await user.click(screen.getByRole("button", { name: /竞品洞察 Agent/ }));
  await user.click(screen.getByRole("button", { name: "Agent 配置" }));
  assert.equal(screen.queryByRole("radio", { name: /Claude Sonnet/ }), null);

  await user.click(screen.getByRole("button", { name: "模型配置" }));
  await user.click(screen.getByRole("button", { name: "删除 Claude Sonnet" }));
  assert.equal(screen.queryByText("Claude Sonnet"), null);
  assert.equal(screen.queryByLabelText(/api key|token|password|credential/i), null);
});

test("chat agent selects only enabled models and requires configuration when none remain", async () => {
  const user = userEvent.setup({ document });
  render(<Home />);

  for (const [controlName, previewMessage] of [
    ["添加附件", "附件功能尚未接入"],
    ["工具", "工具功能尚未接入"],
    ["语音输入", "语音输入尚未接入"],
  ] as const) {
    await user.click(screen.getByRole("button", { name: controlName }));
    assert.equal(
      screen.getByRole("status", { name: "设计预览提示" }).textContent,
      previewMessage,
    );
  }

  await user.click(screen.getByRole("button", { name: "发送" }));
  assert.equal(
    screen.getByRole("status", { name: "设计预览提示" }).textContent,
    "当前为界面预览，真实聊天模型尚未接入",
  );

  await user.click(screen.getByRole("button", { name: "分析竞品账号" }));
  assert.match(
    screen.getByRole("status", { name: "设计预览提示" }).textContent ?? "",
    /已选择：分析竞品账号/,
  );

  await user.click(screen.getByRole("button", { name: "模型配置" }));
  await user.type(screen.getByLabelText("服务商"), "Anthropic");
  await user.type(screen.getByLabelText("模型显示名称"), "Claude Sonnet");
  await user.type(screen.getByLabelText("模型 ID"), "claude-sonnet");
  await user.click(screen.getByRole("checkbox", { name: "添加后启用" }));
  await user.click(screen.getByRole("button", { name: "添加模型" }));

  await user.click(screen.getByRole("button", { name: "AI 对话" }));
  const modelPicker = screen.getByRole("button", {
    name: "选择模型，当前 GPT-5.6",
  });
  await user.click(modelPicker);
  assert.equal(modelPicker.getAttribute("aria-expanded"), "true");
  assert.equal(modelPicker.hasAttribute("aria-haspopup"), false);
  const modelPickerPopup = screen.getByRole("group", { name: "已启用模型" });
  assert.equal(modelPickerPopup.id, "enabled-model-picker");
  assert.equal(modelPicker.getAttribute("aria-controls"), modelPickerPopup.id);
  assert.equal(screen.queryByRole("menu"), null);
  await user.click(screen.getByRole("button", { name: /Claude Sonnet/ }));
  assert.equal(
    screen.getByRole("button", { name: "选择模型，当前 Claude Sonnet" }).getAttribute(
      "aria-expanded",
    ),
    "false",
  );
  assert.equal((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled, false);

  await user.click(screen.getByRole("button", { name: "模型配置" }));
  await user.click(screen.getByRole("button", { name: "停用 GPT-5.6" }));
  await user.click(screen.getByRole("button", { name: "停用 Claude Sonnet" }));
  await user.click(screen.getByRole("button", { name: "AI 对话" }));

  assert.ok(screen.getByRole("button", { name: "请先添加模型" }));
  assert.equal((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled, true);
  await user.click(screen.getByRole("button", { name: "请先添加模型" }));
  assert.ok(screen.getByRole("heading", { name: "全局可用模型" }));
});

test("keeps content matrix configuration separate while other Agents select enabled global models", async () => {
  const user = userEvent.setup({ document });
  render(<Home />);

  await user.click(screen.getByRole("button", { name: /内容矩阵 Agent/ }));
  await user.click(screen.getByRole("button", { name: "Agent 对话" }));
  assert.equal(
    screen.getByRole("button", { name: "Agent 对话" }).getAttribute("aria-current"),
    "page",
  );
  assert.ok(screen.getByRole("heading", { name: "企业矩阵基建诊断表" }));

  await user.click(screen.getByRole("button", { name: "Agent 配置" }));
  assert.ok(
    screen.getByRole("heading", {
      name: "内容矩阵 Agent · 当前会话模型",
    }),
  );
  await user.selectOptions(screen.getByLabelText("服务商预设"), "anthropic");
  assert.equal(
    (screen.getByLabelText("协议") as HTMLSelectElement).value,
    "anthropic",
  );

  await user.click(screen.getByRole("button", { name: "← 返回 Agent 项目" }));
  await user.click(screen.getByRole("button", { name: /竞品洞察 Agent/ }));
  await user.click(screen.getByRole("button", { name: "Agent 配置" }));
  assert.equal(
    (screen.getByRole("radio", { name: /GPT-5\.6 OpenAI/ }) as HTMLInputElement).checked,
    true,
  );
  assert.equal(screen.queryByRole("radio", { name: /Claude/ }), null);
});

test("content matrix Agent collects intake details before marking diagnostic materials ready", async () => {
  const user = userEvent.setup({ document });
  render(<Home />);

  await user.click(screen.getByRole("button", { name: /内容矩阵 Agent/ }));
  assert.ok(screen.getByText("matrix-designer 已安装"));
  assert.ok(screen.getByText("本项目输入"));
  assert.ok(screen.getByText("业务目标、产品、平台与目标人群"));
  assert.match(screen.getByText(/状态：/).textContent ?? "", /等待接收本项目任务/);
  await user.click(screen.getByRole("button", { name: "开始矩阵诊断" }));

  assert.equal(
    screen.getByRole("button", { name: "Agent 对话" }).getAttribute("aria-current"),
    "page",
  );
  assert.ok(screen.getByRole("heading", { name: "企业矩阵基建诊断表" }));
  assert.match(screen.getByText(/必填完成度/).textContent ?? "", /0\s*\/\s*12/);

  await user.click(screen.getByRole("button", { name: "提交诊断" }));
  assert.match(screen.getByRole("alert").textContent ?? "", /主攻平台/);
  assert.match(screen.getByRole("alert").textContent ?? "", /产品\/服务描述/);
  assert.match(
    screen.getByLabelText("小红书").closest("fieldset")?.textContent ?? "",
    /主攻平台.*必填/,
  );
  assert.equal(
    screen.getByLabelText("小红书").closest("fieldset")?.getAttribute("aria-required"),
    "true",
  );
  assert.equal(
    screen.getByLabelText("小红书").closest("fieldset")?.getAttribute("aria-invalid"),
    "true",
  );
  assert.equal(screen.getByLabelText("产品/服务描述").getAttribute("aria-required"), "true");
  assert.equal(screen.getByLabelText("产品/服务描述").getAttribute("aria-invalid"), "true");

  await user.click(screen.getByLabelText("小红书"));
  assert.doesNotMatch(screen.getByRole("alert").textContent ?? "", /主攻平台/);
  assert.match(screen.getByRole("alert").textContent ?? "", /产品\/服务描述/);
  assert.equal(
    screen.getByLabelText("小红书").closest("fieldset")?.getAttribute("aria-invalid"),
    null,
  );
  await user.type(screen.getByLabelText("产品/服务描述"), "全国可发货的健康生活方式内容服务");
  await user.click(screen.getByLabelText("全国可做"));
  await user.click(screen.getByLabelText("获取客资"));
  await user.click(screen.getByLabelText("不分离"));
  await user.type(screen.getByLabelText("客户核心顾虑"), "担心内容不实用");
  await user.click(screen.getByLabelText("有人没钱"));
  await user.click(screen.getByLabelText("无大 IP"));
  await user.click(screen.getByLabelText("所有账号必须归属公司"));
  await user.click(screen.getByLabelText("0到1"));
  await user.click(screen.getByLabelText("完全不知道竞品怎么玩的"));
  await user.click(screen.getByLabelText("常规行业"));

  assert.match(screen.getByText(/必填完成度/).textContent ?? "", /12\s*\/\s*12/);
  await user.click(screen.getByRole("button", { name: "提交诊断" }));
  assert.match(
    screen.getByRole("status", { name: "诊断提交状态" }).textContent ?? "",
    /诊断资料已就绪，等待下一阶段接入模型进行战略分析/,
  );
});

test("video account intake requires private assets before it can become ready", async () => {
  const user = userEvent.setup({ document });
  render(<Home />);

  await user.click(screen.getByRole("button", { name: /内容矩阵 Agent/ }));
  await user.click(screen.getByRole("button", { name: "开始矩阵诊断" }));
  await user.click(screen.getByLabelText("视频号"));
  await user.type(screen.getByLabelText("产品/服务描述"), "全国可发货的健康生活方式内容服务");
  await user.click(screen.getByLabelText("全国可做"));
  await user.click(screen.getByLabelText("获取客资"));
  await user.click(screen.getByLabelText("不分离"));
  await user.type(screen.getByLabelText("客户核心顾虑"), "担心内容不实用");
  await user.click(screen.getByLabelText("有人没钱"));
  await user.click(screen.getByLabelText("无大 IP"));
  await user.click(screen.getByLabelText("所有账号必须归属公司"));
  await user.click(screen.getByLabelText("0到1"));
  await user.click(screen.getByLabelText("完全不知道竞品怎么玩的"));
  await user.click(screen.getByLabelText("常规行业"));

  assert.match(screen.getByText(/必填完成度/).textContent ?? "", /12\s*\/\s*13/);
  await user.click(screen.getByRole("button", { name: "提交诊断" }));
  assert.match(screen.getByRole("alert").textContent ?? "", /私域资产/);
  assert.equal(screen.queryByRole("status", { name: "诊断提交状态" }), null);

  await user.click(screen.getByLabelText("已有大量老客户微信/社群"));
  assert.match(screen.getByText(/必填完成度/).textContent ?? "", /13\s*\/\s*13/);
  await user.click(screen.getByRole("button", { name: "提交诊断" }));
  assert.ok(screen.getByRole("status", { name: "诊断提交状态" }));
});

test("competitor insight Agent does not show the content matrix intake form", async () => {
  const user = userEvent.setup({ document });
  render(<Home />);

  await user.click(screen.getByRole("button", { name: /竞品洞察 Agent/ }));
  await user.click(screen.getByRole("button", { name: "Agent 对话" }));

  assert.equal(screen.queryByRole("heading", { name: "企业矩阵基建诊断表" }), null);
  assert.equal(screen.queryByRole("button", { name: "开始矩阵诊断" }), null);
  assert.match(
    screen.getByRole("status", { name: "设计预览提示" }).textContent ?? "",
    /Agent 对话将在真实 Agent 接入后启用/,
  );
});

test("renders the compliance status required by each Agent output", async () => {
  const user = userEvent.setup({ document });
  render(<Home />);

  await user.click(screen.getByRole("button", { name: /内容矩阵 Agent/ }));
  const compliance = screen.getByRole("status", { name: "成果合规状态" });
  assert.match(compliance.textContent ?? "", /待合规检查/);
  assert.match(compliance.textContent ?? "", /发布前需人工确认/);
  assert.match(
    compliance.textContent ?? "",
    /诊断.*疗效承诺.*停换药.*绝对化表达/,
  );

  await user.click(screen.getByRole("button", { name: "← 返回 Agent 项目" }));
  await user.click(screen.getByRole("button", { name: /竞品洞察 Agent/ }));
  assert.match(
    screen.getByRole("status", { name: "成果合规状态" }).textContent ?? "",
    /当前项目以经营分析为主，仍需人工确认数据口径/,
  );
});
