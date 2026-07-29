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

const { cleanup, render, screen, waitFor } = await import("@testing-library/react");
const { default: userEvent } = await import("@testing-library/user-event");
const { within } = await import("@testing-library/dom");
const { StrictMode, useState } = await import("react");
const { AGENT_PROJECTS } = await import("../app/lib/agent-catalog.mjs");
const { AgentResultFiles } = await import("../app/components/AgentResultFiles");
const { AgentTaskList } = await import("../app/components/AgentTaskList");
const { default: Home } = await import("../app/page");
const originalFetch = globalThis.fetch;

function deferredValue<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

type ConnectedChatModelFixture = {
  id: string;
  provider: string;
  displayName: string;
  modelId: string;
  baseUrl: string;
  apiKey: string;
  revision: string;
  isDefault?: boolean;
};

function installConnectedChatModels(
  fixtures: readonly ConnectedChatModelFixture[],
) {
  window.localStorage.setItem(
    "ai-workbench:model-registry:v2",
    JSON.stringify(
      fixtures.map((fixture, index) => ({
        id: fixture.id,
        provider: fixture.provider,
        displayName: fixture.displayName,
        modelId: fixture.modelId,
        baseUrl: fixture.baseUrl,
        enabled: true,
        isDefault: fixture.isDefault ?? index === 0,
        connectionStatus: "connected",
        testedFingerprint: JSON.stringify([
          fixture.baseUrl,
          fixture.modelId,
          fixture.revision,
        ]),
      })),
    ),
  );
  window.localStorage.setItem(
    "ai-workbench:model-credentials:v1",
    JSON.stringify(
      Object.fromEntries(fixtures.map((fixture) => [fixture.id, fixture.apiKey])),
    ),
  );
  window.localStorage.setItem(
    "ai-workbench:model-credential-revisions:v1",
    JSON.stringify(
      Object.fromEntries(fixtures.map((fixture) => [fixture.id, fixture.revision])),
    ),
  );
}

const createdMarkdownBlobs: Array<{ blob: Blob; url: string }> = [];
const revokedMarkdownUrls: string[] = [];
const clickedDownloadAnchors: HTMLAnchorElement[] = [];

Object.defineProperty(URL, "createObjectURL", {
  configurable: true,
  value: (blob: Blob) => {
    const url = `blob:test-${createdMarkdownBlobs.length + 1}`;
    createdMarkdownBlobs.push({ blob, url });
    return url;
  },
});
Object.defineProperty(URL, "revokeObjectURL", {
  configurable: true,
  value: (url: string) => revokedMarkdownUrls.push(url),
});
dom.window.HTMLAnchorElement.prototype.click = function click() {
  clickedDownloadAnchors.push(this);
};

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
    id: "fixture-running",
    agentId: "content-matrix",
    title: "正在执行任务",
    status: "running",
    progress: 64,
    currentStep: "生成平台内容策略",
    model: "gpt-5.6",
    createdAt: "2026-07-28T03:30:00.000Z",
    updatedAt: "2026-07-28T04:30:00.000Z",
    completedAt: null,
    stoppedAt: null,
    errorSummary: null,
  },
  {
    id: "fixture-completed",
    agentId: "content-matrix",
    title: "内容矩阵成品任务",
    status: "completed",
    progress: 100,
    currentStep: "已生成成果 Markdown",
    model: "gpt-5.6",
    createdAt: "2026-07-28T03:00:00.000Z",
    updatedAt: "2026-07-28T04:00:00.000Z",
    completedAt: "2026-07-28T04:00:00.000Z",
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
    sizeBytes: 56,
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

const unavailableResultFixture: ProjectResult = {
  id: "fixture-unavailable-result",
  agentId: "content-matrix",
  taskId: "fixture-completed",
  filename: "暂不可用成果.md",
  completedAt: "2026-07-28T05:10:00.000Z",
  sizeBytes: 2048,
  markdown: null,
};

const lookupFixtureTask = (taskId: string) =>
  taskStateFixtures.find((task) => task.id === taskId);

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  document.body.style.overflow = "";
  window.localStorage.clear();
  createdMarkdownBlobs.length = 0;
  revokedMarkdownUrls.length = 0;
  clickedDownloadAnchors.length = 0;
  globalThis.fetch = originalFetch;
});

test("Markdown result lists only MD files and opens a read-only preview", async () => {
  const user = userEvent.setup({ document });
  const previewMessages: string[] = [];

  render(
    <AgentResultFiles
      agentId="content-matrix"
      getAgentResults={() => resultFileFixtures}
      getTaskById={lookupFixtureTask}
      initialTaskId={null}
      onPreview={(message) => previewMessages.push(message)}
    />,
  );

  assert.ok(screen.getByText("内容矩阵成果.md"));
  assert.equal(screen.queryByText("内部过程.txt"), null);
  assert.ok(screen.getByText("来源任务：内容矩阵成品任务"));

  await user.click(screen.getByRole("button", { name: /查看内容矩阵成果\.md/ }));

  const dialog = screen.getByRole("dialog", { name: "内容矩阵成果.md" });
  assert.ok(within(dialog).getByText("已完成成果 · 只读预览"));
  assert.match(dialog.textContent ?? "", /这是只读的 Markdown 成果/);
  assert.equal(screen.queryByRole("textbox"), null);
  assert.equal(dialog.querySelector("[contenteditable]"), null);
  assert.equal(screen.queryByRole("button", { name: /编辑/ }), null);
  assert.ok(screen.getByRole("button", { name: "复制内容" }));
  assert.ok(screen.getByRole("button", { name: "下载 MD" }));

  await user.click(screen.getByRole("button", { name: "复制内容" }));
  assert.deepEqual(previewMessages, ["Markdown 内容已复制"]);
  assert.equal(
    screen.getByRole("status", { name: "成果操作状态" }).textContent,
    "Markdown 内容已复制",
  );

  await user.click(screen.getByRole("button", { name: "关闭预览" }));
  assert.equal(screen.queryByRole("dialog"), null);
});

test("Markdown result download uses the exact Blob, filename, and object URL lifecycle", async () => {
  const user = userEvent.setup({ document });

  render(
    <AgentResultFiles
      agentId="content-matrix"
      getAgentResults={() => resultFileFixtures}
      getTaskById={lookupFixtureTask}
      initialTaskId={null}
      onPreview={() => undefined}
    />,
  );

  await user.click(screen.getByRole("button", { name: /查看内容矩阵成果\.md/ }));
  await user.click(screen.getByRole("button", { name: "下载 MD" }));

  assert.equal(createdMarkdownBlobs.length, 1);
  assert.equal(
    createdMarkdownBlobs[0].blob.type,
    "text/markdown;charset=utf-8",
  );
  assert.equal(
    await createdMarkdownBlobs[0].blob.text(),
    "# 内容矩阵成果\n\n这是只读的 Markdown 成果。",
  );
  assert.equal(clickedDownloadAnchors.length, 1);
  assert.equal(clickedDownloadAnchors[0].download, "内容矩阵成果.md");
  assert.equal(clickedDownloadAnchors[0].href, createdMarkdownBlobs[0].url);
  assert.deepEqual(revokedMarkdownUrls, [createdMarkdownBlobs[0].url]);
});

test("Markdown preview reports clipboard rejection inside the modal", async () => {
  const user = userEvent.setup({ document });
  const originalWriteText = navigator.clipboard.writeText;
  const previewMessages: string[] = [];
  Object.assign(navigator.clipboard, {
    writeText: async () => {
      throw new Error("clipboard denied");
    },
  });

  try {
    render(
      <AgentResultFiles
        agentId="content-matrix"
        getAgentResults={() => resultFileFixtures}
        getTaskById={lookupFixtureTask}
        initialTaskId={null}
        onPreview={(message) => previewMessages.push(message)}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /查看内容矩阵成果\.md/ }),
    );
    await user.click(screen.getByRole("button", { name: "复制内容" }));

    assert.equal(
      screen.getByRole("status", { name: "成果操作状态" }).textContent,
      "复制失败，请手动选择内容",
    );
    assert.deepEqual(previewMessages, ["复制失败，请手动选择内容"]);
  } finally {
    Object.assign(navigator.clipboard, { writeText: originalWriteText });
  }
});

test("Markdown preview traps keyboard focus, closes on Escape, and restores its trigger", async () => {
  const user = userEvent.setup({ document });

  render(
    <AgentResultFiles
      agentId="content-matrix"
      getAgentResults={() => resultFileFixtures}
      getTaskById={lookupFixtureTask}
      initialTaskId={null}
      onPreview={() => undefined}
    />,
  );

  const trigger = screen.getByRole("button", {
    name: /查看内容矩阵成果\.md/,
  });
  await user.click(trigger);

  const dialog = screen.getByRole("dialog", { name: "内容矩阵成果.md" });
  const closeButton = within(dialog).getByRole("button", { name: "关闭预览" });
  const downloadButton = within(dialog).getByRole("button", { name: "下载 MD" });
  assert.equal(dialog.contains(document.activeElement), true);
  assert.equal(document.activeElement, closeButton);
  assert.ok(trigger.closest('[aria-hidden="true"]'));
  assert.equal(trigger.closest("[inert]")?.hasAttribute("inert"), true);

  await user.tab({ shift: true });
  assert.equal(document.activeElement, downloadButton);
  await user.tab();
  assert.equal(document.activeElement, closeButton);

  await user.keyboard("{Escape}");
  assert.equal(screen.queryByRole("dialog"), null);
  assert.equal(document.activeElement, trigger);
});

test("task-opened Markdown preview restores focus to the matching result trigger", async () => {
  const user = userEvent.setup({ document });

  render(
    <AgentResultFiles
      agentId="content-matrix"
      getAgentResults={() => resultFileFixtures}
      getTaskById={lookupFixtureTask}
      initialTaskId="fixture-completed"
      onPreview={() => undefined}
    />,
  );

  assert.ok(screen.getByRole("dialog", { name: "内容矩阵成果.md" }));
  const matchingResultTrigger = document.querySelector<HTMLButtonElement>(
    'button[aria-label="查看内容矩阵成果.md"]',
  );
  assert.ok(matchingResultTrigger);

  await user.keyboard("{Escape}");
  assert.equal(screen.queryByRole("dialog"), null);
  assert.equal(document.activeElement, matchingResultTrigger);
});

test("an injected initial result cannot expose Markdown outside the current completed Agent task", () => {
  const injectedMarkdown = "# 不应暴露\n\n跨 Agent 注入内容";
  const injectedTask: ProjectTask = {
    ...taskStateFixtures[2],
    id: "foreign-completed",
    agentId: "competitor-insight",
  };
  const injectedResult: ProjectResult = {
    ...resultFileFixtures[0],
    id: "foreign-result",
    agentId: "competitor-insight",
    taskId: injectedTask.id,
    filename: "跨 Agent 成果.md",
    markdown: injectedMarkdown,
  };

  render(
    <AgentResultFiles
      agentId="content-matrix"
      getAgentResults={() => [injectedResult]}
      getTaskById={(taskId) => taskId === injectedTask.id ? injectedTask : undefined}
      initialTaskId={injectedTask.id}
      onPreview={() => undefined}
    />,
  );

  assert.equal(screen.queryByRole("dialog") === null, true);
  assert.equal(document.body.textContent?.includes(injectedMarkdown), false);
  assert.equal(screen.queryByRole("button", { name: "复制内容" }) === null, true);
  assert.equal(screen.queryByRole("button", { name: "下载 MD" }) === null, true);
  assert.equal(createdMarkdownBlobs.length, 0);
  assert.equal(
    (screen.getByRole("button", {
      name: "跨 Agent 成果.md 来源任务异常，无法打开",
    }) as HTMLButtonElement).disabled,
    true,
  );
});

test("Markdown preview locks body scrolling and restores the exact prior value", async () => {
  const user = userEvent.setup({ document });
  document.body.style.overflow = "clip";
  const view = render(
    <AgentResultFiles
      agentId="content-matrix"
      getAgentResults={() => resultFileFixtures}
      getTaskById={lookupFixtureTask}
      initialTaskId={null}
      onPreview={() => undefined}
    />,
  );

  await user.click(screen.getByRole("button", { name: /查看内容矩阵成果\.md/ }));
  assert.equal(document.body.style.overflow, "hidden");
  await user.click(screen.getByRole("button", { name: "关闭预览" }));
  assert.equal(document.body.style.overflow, "clip");

  document.body.style.overflow = "scroll";
  await user.click(screen.getByRole("button", { name: /查看内容矩阵成果\.md/ }));
  assert.equal(document.body.style.overflow, "hidden");
  view.unmount();
  assert.equal(document.body.style.overflow, "scroll");
});

test("Markdown preview CSS contains scroll chaining and mobile dynamic viewport height", () => {
  const css = readFileSync(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  const backdropRule =
    css.match(/\.result-preview-backdrop\s*\{[^}]*\}/)?.[0] ?? "";
  const mobileStyles = css.slice(
    css.indexOf("@media (max-width: 720px)"),
    css.indexOf("@media (prefers-reduced-motion: reduce)"),
  );
  const mobileDialogRule =
    mobileStyles.match(/\.result-preview-dialog\s*\{[^}]*\}/)?.[0] ?? "";

  assert.match(backdropRule, /overscroll-behavior:\s*contain/);
  assert.match(mobileDialogRule, /max-height:\s*calc\(100dvh - 20px\)/);
});

test("task and result views distinguish empty filters, empty Agents, and unavailable Markdown", async () => {
  const user = userEvent.setup({ document });

  const emptyTasks = render(
    <TaskHistoryHarness
      resultQuery={() => []}
      taskQuery={() => []}
    />,
  );
  assert.ok(screen.getByText("还没有任务，可从 Agent 对话发起"));
  emptyTasks.unmount();

  const historicalTaskQuery = (
    _agentId: string,
    filter: TaskStatusFilter,
  ) => taskStateFixtures.filter(
    (task) => task.status === "completed" && (
      filter === "all" || task.status === filter
    ),
  );
  const filteredTasks = render(
    <TaskHistoryHarness
      resultQuery={() => []}
      taskQuery={historicalTaskQuery}
    />,
  );
  await user.click(screen.getByRole("button", { name: "进行中" }));
  assert.ok(screen.getByText("当前筛选下没有任务"));
  filteredTasks.unmount();

  const emptyResults = render(
    <AgentResultFiles
      agentId="content-matrix"
      getAgentResults={() => []}
      getTaskById={lookupFixtureTask}
      initialTaskId={null}
      onPreview={() => undefined}
    />,
  );
  assert.ok(
    screen.getByText("任务完成后，Markdown 成果会出现在这里"),
  );
  emptyResults.unmount();

  const previewMessages: string[] = [];
  render(
    <AgentResultFiles
      agentId="content-matrix"
      getAgentResults={() => [unavailableResultFixture]}
      getTaskById={lookupFixtureTask}
      initialTaskId={null}
      onPreview={(message) => previewMessages.push(message)}
    />,
  );
  assert.ok(screen.getByText("暂不可用成果.md"));
  assert.match(
    screen.getByText("暂不可用成果.md").closest("article")?.textContent ?? "",
    /2\.0 KB/,
  );
  assert.ok(screen.getByText("来源任务：内容矩阵成品任务"));
  await user.click(screen.getByRole("button", { name: /查看暂不可用成果\.md/ }));
  assert.ok(screen.getByText("暂时无法预览"));
  await user.click(screen.getByRole("button", { name: "重试下载" }));
  assert.deepEqual(previewMessages, ["Markdown 内容暂时不可用，请稍后重试"]);
  assert.equal(
    screen.getByRole("status", { name: "成果操作状态" }).textContent,
    "Markdown 内容暂时不可用，请稍后重试",
  );
  assert.equal(createdMarkdownBlobs.length, 0);
});

test("Markdown result cards expose and block an abnormal missing task relationship", async () => {
  const user = userEvent.setup({ document });
  render(
    <AgentResultFiles
      agentId="content-matrix"
      getAgentResults={() => [{
        ...resultFileFixtures[0],
        taskId: "missing-task",
      }]}
      getTaskById={() => undefined}
      initialTaskId={null}
      onPreview={() => undefined}
    />,
  );

  assert.ok(screen.getByText("来源任务：关联任务异常"));
  const unavailableAction = screen.getByRole("button", {
    name: "内容矩阵成果.md 来源任务异常，无法打开",
  });
  assert.equal((unavailableAction as HTMLButtonElement).disabled, true);
  await user.click(unavailableAction);
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
  const resultFilesTab = within(navigation).getByRole("button", {
    name: "成果文件",
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

  assert.equal(resultFilesTab.getAttribute("aria-current"), "page");
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
  assert.equal(screen.queryByRole("dialog"), null);
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

test("task history renders status-specific waiting, running, completed, stopped, and failed information", () => {
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
  assert.ok(screen.getByRole("heading", { name: "正在执行任务" }));
  assert.ok(screen.getByRole("heading", { name: "内容矩阵成品任务" }));
  assert.ok(screen.getByRole("heading", { name: "执行失败任务" }));
  assert.ok(screen.getByRole("heading", { name: "已停止任务" }));
  assert.ok(screen.getAllByText("等待中").length > 0);
  assert.ok(screen.getAllByText("进行中").length > 0);
  assert.ok(screen.getAllByText("已完成").length > 0);
  assert.ok(screen.getAllByText("失败").length > 0);
  assert.ok(screen.getAllByText("已停止").length > 0);

  const waitingCard = screen.getByRole("heading", {
    name: "等待执行任务",
  }).closest("article");
  const runningCard = screen.getByRole("heading", {
    name: "正在执行任务",
  }).closest("article");
  const completedCard = screen.getByRole("heading", {
    name: "内容矩阵成品任务",
  }).closest("article");
  const stoppedCard = screen.getByRole("heading", {
    name: "已停止任务",
  }).closest("article");
  const failedCard = screen.getByRole("heading", {
    name: "执行失败任务",
  }).closest("article");

  assert.ok(waitingCard);
  assert.ok(runningCard);
  assert.ok(completedCard);
  assert.ok(stoppedCard);
  assert.ok(failedCard);
  assert.ok(within(waitingCard).getByText("等待开始"));
  assert.match(runningCard.textContent ?? "", /当前步骤：生成平台内容策略/);
  assert.equal(
    within(runningCard).getByRole("progressbar").getAttribute("aria-valuenow"),
    "64",
  );
  assert.ok(within(completedCard).getByText("完成于 07/28 12:00"));
  assert.ok(within(stoppedCard).getByText("停止于 07/28 10:20"));
  assert.match(
    failedCard.textContent ?? "",
    /模型连接超时，请检查配置后重试/,
  );
  assert.equal(within(failedCard).queryByRole("alert"), null);
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
    ["模型配置", "模型设置"],
    ["AI 对话", "今天想聊什么，或推进什么任务？"],
    ["Agent 项目", "9 个独立 Agent 项目"],
  ] as const;

  for (const [navigationLabel, heading] of views) {
    await user.click(screen.getByRole("button", { name: navigationLabel }));
    assert.ok(screen.getByRole("heading", { name: heading }));
    if (navigationLabel === "模型配置") {
      assert.ok(screen.getByLabelText("文案模型 API Key"));
      assert.ok(screen.getByLabelText("生图模型 API Key"));
      assert.ok(screen.getByRole("button", { name: "测试文案模型" }));
      assert.ok(screen.getByRole("button", { name: "测试生图模型" }));
      assert.ok(screen.getByRole("button", { name: "保存设置" }));
    }
  }

  const primaryNavigation = screen.getByRole("navigation", { name: "主导航" });
  const settingsButton = screen.getByRole("button", { name: "系统设置" });
  assert.equal(primaryNavigation.contains(settingsButton), true);
  await user.click(settingsButton);
  assert.ok(screen.getByRole("heading", { name: "系统设置" }));
});

test("global model settings mask saved credentials and preserve or explicitly clear them", async () => {
  window.localStorage.setItem(
    "ai-workbench:model-registry:v2",
    JSON.stringify([
      {
        id: "openai-gpt-5-6",
        provider: "OpenAI",
        displayName: "GPT-5.6",
        modelId: "gpt-5.6",
        baseUrl: "https://api.openai.com/v1",
        enabled: true,
        isDefault: true,
        connectionStatus: "connected",
        testedFingerprint:
          "[\"https://api.openai.com/v1\",\"gpt-5.6\",\"revision-saved-key\"]",
      },
    ]),
  );
  window.localStorage.setItem(
    "ai-workbench:model-credentials:v1",
    JSON.stringify({ "openai-gpt-5-6": "sk-fake-saved-key-1234" }),
  );
  window.localStorage.setItem(
    "ai-workbench:model-credential-revisions:v1",
    JSON.stringify({ "openai-gpt-5-6": "revision-saved-key" }),
  );
  window.localStorage.setItem(
    "ai-workbench:image-model-config:v1",
    JSON.stringify({
      baseUrl: "https://api.openai.com/v1",
      modelId: "image-test",
      enabled: false,
      connectionStatus: "untested",
      testedFingerprint: "",
    }),
  );
  window.localStorage.setItem(
    "ai-workbench:image-model-credential:v1",
    "sk-fake-image-saved-5678",
  );
  const user = userEvent.setup({ document });
  render(<Home />);

  await user.click(screen.getByRole("button", { name: "模型配置" }));
  assert.ok(screen.getByRole("heading", { name: "模型设置" }));
  assert.ok(
    screen.getByText("分别填写文案模型和生图模型的 API Key、Base URL、模型名称。"),
  );
  assert.ok(screen.getByRole("heading", { name: "文案模型" }));
  assert.ok(screen.getByRole("heading", { name: "生图模型" }));
  assert.ok(screen.getByText("浏览器本机保存不是硬件级加密，同源脚本可读取。"));
  const savedKeyLines = screen.getAllByText(/已保存 Key：/);
  assert.equal(savedKeyLines.some((line) => /sk-…1234/.test(line.textContent ?? "")), true);
  assert.equal(savedKeyLines.some((line) => /sk-…5678/.test(line.textContent ?? "")), true);
  assert.equal(document.body.textContent?.includes("sk-fake-saved-key-1234"), false);
  assert.equal(document.body.textContent?.includes("sk-fake-image-saved-5678"), false);
  assert.equal((screen.getByLabelText("文案模型 API Key") as HTMLInputElement).value, "");

  await user.clear(screen.getByLabelText("文案接口地址"));
  await user.type(screen.getByLabelText("文案接口地址"), "https://api.openai.com/changed");
  assert.equal(
    screen.getByRole("status", { name: "GPT-5.6 连接状态" }).textContent,
    "配置已变更",
  );
  await user.click(screen.getByRole("button", { name: "取消" }));
  assert.equal(
    (screen.getByLabelText("文案接口地址") as HTMLInputElement).value,
    "https://api.openai.com/v1",
  );

  await user.click(screen.getByRole("button", { name: "保存设置" }));
  await waitFor(() => {
    assert.match(
      window.localStorage.getItem("ai-workbench:model-credentials:v1") ?? "",
      /sk-fake-saved-key-1234/,
    );
  });

  await user.click(
    screen.getByRole("checkbox", { name: "清空已保存的文案 API Key" }),
  );
  await user.click(screen.getByRole("button", { name: "保存设置" }));
  await waitFor(() => {
    assert.deepEqual(
      JSON.parse(
        window.localStorage.getItem("ai-workbench:model-credentials:v1") ?? "null",
      ),
      {},
    );
  });
});

test("global text model test uses the safe proxy and only connected drafts can be enabled", async () => {
  const requests: Array<{ url: string; body: unknown }> = [];
  let probeAttempt = 0;
  globalThis.fetch = (async (input, init) => {
    probeAttempt += 1;
    requests.push({
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (probeAttempt === 1) {
      return Response.json(
        { ok: false, message: "API Key 无效" },
        { status: 401 },
      );
    }
    return Response.json({ ok: true });
  }) as typeof fetch;
  const user = userEvent.setup({ document });
  render(<Home />);

  await user.click(screen.getByRole("button", { name: "模型配置" }));
  const enabled = screen.getByRole("checkbox", { name: "启用 GPT-5.6" });
  assert.equal((enabled as HTMLInputElement).disabled, true);
  await user.clear(screen.getByLabelText("文案接口地址"));
  await user.type(screen.getByLabelText("文案接口地址"), "https://api.openai.com/v1");
  await user.type(screen.getByLabelText("文案模型 API Key"), "sk-fake-proxy-key");
  assert.equal(
    screen.getByRole("status", { name: "GPT-5.6 连接状态" }).textContent,
    "配置已变更",
  );
  await user.click(screen.getByRole("button", { name: "测试文案模型" }));
  await waitFor(() => {
    assert.equal(
      screen.getByRole("status", { name: "GPT-5.6 连接状态" }).textContent,
      "连接失败",
    );
  });
  assert.equal((enabled as HTMLInputElement).disabled, true);

  await user.click(screen.getByRole("button", { name: "测试文案模型" }));
  await waitFor(() => {
    assert.equal(
      screen.getByRole("status", { name: "GPT-5.6 连接状态" }).textContent,
      "连接成功",
    );
  });
  assert.equal(requests[0]?.url, "/api/models/test-text");
  assert.equal(requests[1]?.url, "/api/models/test-text");
  assert.deepEqual(requests[0]?.body, {
    config: {
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-fake-proxy-key",
      model: "gpt-5.6",
    },
  });
  assert.equal((enabled as HTMLInputElement).disabled, false);
  await waitFor(() => {
    const revisions = JSON.parse(
      window.localStorage.getItem(
        "ai-workbench:model-credential-revisions:v1",
      ) ?? "{}",
    );
    const storedModels = JSON.parse(
      window.localStorage.getItem("ai-workbench:model-registry:v2") ?? "[]",
    );
    const storedModel = storedModels.find(
      (model: { id: string }) => model.id === "openai-gpt-5-6",
    );
    assert.ok(revisions["openai-gpt-5-6"]);
    assert.deepEqual(JSON.parse(storedModel.testedFingerprint), [
      "https://api.openai.com/v1",
      "gpt-5.6",
      revisions["openai-gpt-5-6"],
    ]);
    assert.doesNotMatch(storedModel.testedFingerprint, /sk-fake-proxy-key/);
  });
});

test("editing a text connection aborts its probe and ignores the stale success", async () => {
  const pending = deferredValue<Response>();
  let requestSignal: AbortSignal | null = null;
  globalThis.fetch = (async (_input, init) => {
    requestSignal = init?.signal as AbortSignal;
    return pending.promise;
  }) as typeof fetch;
  const user = userEvent.setup({ document });
  render(<Home />);

  await user.click(screen.getByRole("button", { name: "模型配置" }));
  await user.type(screen.getByLabelText("文案模型 API Key"), "sk-stale-text-edit");
  await user.type(screen.getByLabelText("文案接口地址"), "https://api.openai.com/v1");
  await user.click(screen.getByRole("button", { name: "测试文案模型" }));
  await waitFor(() => assert.ok(requestSignal));

  await user.type(screen.getByLabelText("文案模型名称"), "-changed");
  pending.resolve(Response.json({ ok: true }));

  await waitFor(() => {
    assert.equal(
      screen.getByRole("status", { name: "GPT-5.6 连接状态" }).textContent,
      "配置已变更",
    );
  });
  assert.equal(requestSignal?.aborted, true);
  assert.doesNotMatch(
    window.localStorage.getItem("ai-workbench:model-credentials:v1") ?? "",
    /sk-stale-text-edit/,
  );
});

test("canceling a text draft aborts its probe and restores the prior credential", async () => {
  window.localStorage.setItem(
    "ai-workbench:model-credentials:v1",
    JSON.stringify({ "openai-gpt-5-6": "sk-original-text" }),
  );
  window.localStorage.setItem(
    "ai-workbench:model-credential-revisions:v1",
    JSON.stringify({ "openai-gpt-5-6": "revision-original-text" }),
  );
  const pending = deferredValue<Response>();
  let requestSignal: AbortSignal | null = null;
  globalThis.fetch = (async (_input, init) => {
    requestSignal = init?.signal as AbortSignal;
    return pending.promise;
  }) as typeof fetch;
  const user = userEvent.setup({ document });
  render(<Home />);

  await user.click(screen.getByRole("button", { name: "模型配置" }));
  await user.type(screen.getByLabelText("文案模型 API Key"), "sk-stale-cancel");
  await user.type(screen.getByLabelText("文案接口地址"), "https://api.openai.com/v1");
  await user.click(screen.getByRole("button", { name: "测试文案模型" }));
  await waitFor(() => assert.ok(requestSignal));
  await user.click(screen.getByRole("button", { name: "取消" }));
  pending.resolve(Response.json({ ok: true }));

  await waitFor(() => {
    assert.deepEqual(
      JSON.parse(
        window.localStorage.getItem("ai-workbench:model-credentials:v1") ?? "{}",
      ),
      { "openai-gpt-5-6": "sk-original-text" },
    );
  });
  assert.equal(requestSignal?.aborted, true);
});

test("cancel fully restores credentials, deletion, addition, and the default model", async () => {
  const originalModels = [
    {
      id: "model-alpha",
      provider: "OpenAI",
      displayName: "Alpha",
      modelId: "alpha-1",
      baseUrl: "https://api.alpha.example/v1",
      enabled: true,
      isDefault: true,
      connectionStatus: "connected",
      testedFingerprint:
        "[\"https://api.alpha.example/v1\",\"alpha-1\",\"revision-alpha\"]",
    },
    {
      id: "model-beta",
      provider: "OpenAI",
      displayName: "Beta",
      modelId: "beta-1",
      baseUrl: "https://api.beta.example/v1",
      enabled: true,
      isDefault: false,
      connectionStatus: "connected",
      testedFingerprint:
        "[\"https://api.beta.example/v1\",\"beta-1\",\"revision-beta\"]",
    },
  ];
  const originalCredentials = {
    "model-alpha": "sk-original-alpha",
    "model-beta": "sk-original-beta",
  };
  const originalRevisions = {
    "model-alpha": "revision-alpha",
    "model-beta": "revision-beta",
  };
  window.localStorage.setItem(
    "ai-workbench:model-registry:v2",
    JSON.stringify(originalModels),
  );
  window.localStorage.setItem(
    "ai-workbench:model-credentials:v1",
    JSON.stringify(originalCredentials),
  );
  window.localStorage.setItem(
    "ai-workbench:model-credential-revisions:v1",
    JSON.stringify(originalRevisions),
  );
  const user = userEvent.setup({ document });
  render(<Home />);

  await user.click(screen.getByRole("button", { name: "模型配置" }));
  await user.click(screen.getByRole("button", { name: "删除 Alpha" }));
  await user.click(screen.getByRole("radio", { name: "设为默认" }));
  await user.type(
    within(screen.getByRole("heading", { name: "Beta" }).closest("article")!)
      .getByLabelText("文案模型 API Key"),
    "sk-replacement-beta",
  );

  await user.click(screen.getByRole("button", { name: "添加文案模型" }));
  const newModelCard = screen
    .getByRole("heading", { name: "新增文案模型" })
    .closest("article");
  assert.ok(newModelCard);
  const newModel = within(newModelCard);
  await user.type(newModel.getByLabelText("服务商"), "Example");
  await user.type(newModel.getByLabelText("模型显示名称"), "Gamma");
  await user.type(newModel.getByLabelText("文案模型 API Key"), "sk-new-gamma");
  await user.type(
    newModel.getByLabelText("文案接口地址"),
    "https://api.gamma.example/v1",
  );
  await user.type(newModel.getByLabelText("文案模型名称"), "gamma-1");
  await user.click(newModel.getByRole("button", { name: "添加模型" }));
  assert.ok(screen.getByRole("heading", { name: "Gamma" }));

  await user.click(screen.getByRole("button", { name: "取消" }));

  await waitFor(() => {
    assert.ok(screen.getByRole("heading", { name: "Alpha" }));
    assert.ok(screen.getByRole("heading", { name: "Beta" }));
    assert.equal(screen.queryByRole("heading", { name: "Gamma" }), null);
    assert.deepEqual(
      JSON.parse(
        window.localStorage.getItem("ai-workbench:model-credentials:v1") ?? "{}",
      ),
      originalCredentials,
    );
    assert.deepEqual(
      JSON.parse(
        window.localStorage.getItem("ai-workbench:model-credential-revisions:v1") ?? "{}",
      ),
      originalRevisions,
    );
    const restoredModels = JSON.parse(
      window.localStorage.getItem("ai-workbench:model-registry:v2") ?? "[]",
    );
    assert.deepEqual(
      restoredModels.map((model: { id: string }) => model.id),
      ["model-alpha", "model-beta"],
    );
    assert.equal(
      restoredModels.find((model: { id: string }) => model.id === "model-alpha")
        ?.isDefault,
      true,
    );
  });
});

test("deleting a tested text draft cannot leave an orphan credential", async () => {
  const pending = deferredValue<Response>();
  let requestSignal: AbortSignal | null = null;
  globalThis.fetch = (async (_input, init) => {
    requestSignal = init?.signal as AbortSignal;
    return pending.promise;
  }) as typeof fetch;
  const user = userEvent.setup({ document });
  render(<Home />);

  await user.click(screen.getByRole("button", { name: "模型配置" }));
  await user.type(screen.getByLabelText("文案模型 API Key"), "sk-orphan-text");
  await user.type(screen.getByLabelText("文案接口地址"), "https://api.openai.com/v1");
  await user.click(screen.getByRole("button", { name: "测试文案模型" }));
  await waitFor(() => assert.ok(requestSignal));
  await user.click(screen.getByRole("button", { name: "删除 GPT-5.6" }));
  await user.click(screen.getByRole("button", { name: "保存设置" }));
  pending.resolve(Response.json({ ok: true }));

  await waitFor(() => {
    assert.deepEqual(
      JSON.parse(
        window.localStorage.getItem("ai-workbench:model-credentials:v1") ?? "{}",
      ),
      {},
    );
    assert.deepEqual(
      JSON.parse(
        window.localStorage.getItem("ai-workbench:model-registry:v2") ?? "[]",
      ),
      [],
    );
  });
  assert.equal(requestSignal?.aborted, true);
});

for (const [lateResult, response] of [
  ["success", () => Response.json({ ok: true })],
  [
    "failure",
    () => Response.json(
      { ok: false, message: "已删除模型的旧请求失败" },
      { status: 401 },
    ),
  ],
] as const) {
  test(`deleting a pending text probe settles it before an invalid save and ignores late ${lateResult}`, async () => {
    const originalModels = [
      {
        id: "model-alpha",
        provider: "OpenAI",
        displayName: "Alpha",
        modelId: "alpha-1",
        baseUrl: "https://api.alpha.example/v1",
        enabled: true,
        isDefault: true,
        connectionStatus: "connected",
        testedFingerprint:
          "[\"https://api.alpha.example/v1\",\"alpha-1\",\"revision-alpha\"]",
      },
      {
        id: "model-beta",
        provider: "OpenAI",
        displayName: "Beta",
        modelId: "beta-1",
        baseUrl: "https://api.beta.example/v1",
        enabled: true,
        isDefault: false,
        connectionStatus: "connected",
        testedFingerprint:
          "[\"https://api.beta.example/v1\",\"beta-1\",\"revision-beta\"]",
      },
    ];
    const originalCredentials = {
      "model-alpha": "sk-original-alpha",
      "model-beta": "sk-original-beta",
    };
    const originalRevisions = {
      "model-alpha": "revision-alpha",
      "model-beta": "revision-beta",
    };
    window.localStorage.setItem(
      "ai-workbench:model-registry:v2",
      JSON.stringify(originalModels),
    );
    window.localStorage.setItem(
      "ai-workbench:model-credentials:v1",
      JSON.stringify(originalCredentials),
    );
    window.localStorage.setItem(
      "ai-workbench:model-credential-revisions:v1",
      JSON.stringify(originalRevisions),
    );
    const pending = deferredValue<Response>();
    let requestSignal: AbortSignal | null = null;
    globalThis.fetch = (async (_input, init) => {
      requestSignal = init?.signal as AbortSignal;
      return pending.promise;
    }) as typeof fetch;
    const user = userEvent.setup({ document });
    render(<Home />);

    await user.click(screen.getByRole("button", { name: "模型配置" }));
    const alphaCard = screen.getByRole("heading", { name: "Alpha" }).closest("article");
    const betaCard = screen.getByRole("heading", { name: "Beta" }).closest("article");
    assert.ok(alphaCard);
    assert.ok(betaCard);
    await user.click(
      within(alphaCard).getByRole("button", { name: "测试文案模型" }),
    );
    await waitFor(() => assert.ok(requestSignal));
    await user.click(screen.getByRole("button", { name: "删除 Alpha" }));
    await user.clear(within(betaCard).getByLabelText("服务商"));
    await user.click(screen.getByRole("button", { name: "保存设置" }));

    await waitFor(() => {
      assert.equal(requestSignal?.aborted, true);
      assert.match(
        screen.getByRole("alert").textContent ?? "",
        /请填写每个文案模型/,
      );
      const storedModels = JSON.parse(
        window.localStorage.getItem("ai-workbench:model-registry:v2") ?? "[]",
      );
      assert.equal(
        storedModels.find((model: { id: string }) => model.id === "model-alpha")
          ?.connectionStatus,
        "connected",
      );
      assert.deepEqual(
        JSON.parse(
          window.localStorage.getItem("ai-workbench:model-credentials:v1") ?? "{}",
        ),
        originalCredentials,
      );
    });

    pending.resolve(response());
    await waitFor(() => {
      const storedModels = JSON.parse(
        window.localStorage.getItem("ai-workbench:model-registry:v2") ?? "[]",
      );
      assert.equal(
        storedModels.find((model: { id: string }) => model.id === "model-alpha")
          ?.connectionStatus,
        "connected",
      );
      assert.deepEqual(
        JSON.parse(
          window.localStorage.getItem("ai-workbench:model-credentials:v1") ?? "{}",
        ),
        originalCredentials,
      );
    });

    await user.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => {
      assert.ok(screen.getByRole("heading", { name: "Alpha" }));
      assert.ok(screen.getByRole("heading", { name: "Beta" }));
      assert.deepEqual(
        JSON.parse(
          window.localStorage.getItem("ai-workbench:model-registry:v2") ?? "[]",
        ),
        originalModels,
      );
      assert.deepEqual(
        JSON.parse(
          window.localStorage.getItem("ai-workbench:model-credentials:v1") ?? "{}",
        ),
        originalCredentials,
      );
      assert.deepEqual(
        JSON.parse(
          window.localStorage.getItem(
            "ai-workbench:model-credential-revisions:v1",
          ) ?? "{}",
        ),
        originalRevisions,
      );
    });
  });
}

test("a newer text probe wins and an older failure cannot overwrite it", async () => {
  const first = deferredValue<Response>();
  const second = deferredValue<Response>();
  const requestSignals: AbortSignal[] = [];
  let callCount = 0;
  globalThis.fetch = (async (_input, init) => {
    requestSignals.push(init?.signal as AbortSignal);
    callCount += 1;
    return callCount === 1 ? first.promise : second.promise;
  }) as typeof fetch;
  const user = userEvent.setup({ document });
  render(<Home />);

  await user.click(screen.getByRole("button", { name: "模型配置" }));
  await user.type(screen.getByLabelText("文案模型 API Key"), "sk-retest-text");
  await user.type(screen.getByLabelText("文案接口地址"), "https://api.openai.com/v1");
  await user.click(screen.getByRole("button", { name: "测试文案模型" }));
  await waitFor(() => assert.equal(callCount, 1));
  await user.click(screen.getByRole("button", { name: /正在测试|重新测试/ }));
  await waitFor(() => assert.equal(callCount, 2));

  second.resolve(Response.json({ ok: true }));
  await waitFor(() => {
    assert.equal(
      screen.getByRole("status", { name: "GPT-5.6 连接状态" }).textContent,
      "连接成功",
    );
  });
  first.resolve(
    Response.json({ ok: false, message: "旧请求失败" }, { status: 401 }),
  );
  await waitFor(() => {
    assert.equal(
      screen.getByRole("status", { name: "GPT-5.6 连接状态" }).textContent,
      "连接成功",
    );
  });
  assert.equal(requestSignals[0]?.aborted, true);
});

test("leaving model settings aborts a text probe before its stale success", async () => {
  const pending = deferredValue<Response>();
  let requestSignal: AbortSignal | null = null;
  globalThis.fetch = (async (_input, init) => {
    requestSignal = init?.signal as AbortSignal;
    return pending.promise;
  }) as typeof fetch;
  const user = userEvent.setup({ document });
  render(<Home />);

  await user.click(screen.getByRole("button", { name: "模型配置" }));
  await user.type(screen.getByLabelText("文案模型 API Key"), "sk-unmounted-text");
  await user.type(screen.getByLabelText("文案接口地址"), "https://api.openai.com/v1");
  await user.click(screen.getByRole("button", { name: "测试文案模型" }));
  await waitFor(() => assert.ok(requestSignal));
  await user.click(screen.getByRole("button", { name: "AI 对话" }));
  pending.resolve(Response.json({ ok: true }));

  await waitFor(() => {
    assert.doesNotMatch(
      window.localStorage.getItem("ai-workbench:model-credentials:v1") ?? "",
      /sk-unmounted-text/,
    );
  });
  assert.equal(requestSignal?.aborted, true);
});

test("saving during a text probe aborts it and persists a settled non-testing state", async () => {
  const pending = deferredValue<Response>();
  let requestSignal: AbortSignal | null = null;
  globalThis.fetch = (async (_input, init) => {
    requestSignal = init?.signal as AbortSignal;
    return pending.promise;
  }) as typeof fetch;
  const user = userEvent.setup({ document });
  render(<Home />);

  await user.click(screen.getByRole("button", { name: "模型配置" }));
  await user.type(screen.getByLabelText("文案模型 API Key"), "sk-save-race-text");
  await user.type(
    screen.getByLabelText("文案接口地址"),
    "https://api.openai.com/v1",
  );
  await user.click(screen.getByRole("button", { name: "测试文案模型" }));
  await waitFor(() => assert.ok(requestSignal));
  await user.click(screen.getByRole("button", { name: "保存设置" }));

  await waitFor(() => {
    assert.equal(requestSignal?.aborted, true);
    assert.equal(
      screen.getByRole("status", { name: "GPT-5.6 连接状态" }).textContent,
      "未测试",
    );
    const stored = JSON.parse(
      window.localStorage.getItem("ai-workbench:model-registry:v2") ?? "[]",
    );
    assert.equal(stored[0]?.connectionStatus, "untested");
  });

  pending.resolve(Response.json({ ok: true }));
  await waitFor(() => {
    assert.equal(
      screen.getByRole("status", { name: "GPT-5.6 连接状态" }).textContent,
      "未测试",
    );
    assert.equal(
      JSON.parse(
        window.localStorage.getItem("ai-workbench:model-registry:v2") ?? "[]",
      )[0]?.connectionStatus,
      "untested",
    );
  });
});

test("text save validation failure settles its aborted probe and ignores the stale response", async () => {
  const pending = deferredValue<Response>();
  let requestSignal: AbortSignal | null = null;
  globalThis.fetch = (async (_input, init) => {
    requestSignal = init?.signal as AbortSignal;
    return pending.promise;
  }) as typeof fetch;
  const user = userEvent.setup({ document });
  render(<Home />);

  await user.click(screen.getByRole("button", { name: "模型配置" }));
  await user.type(
    screen.getByLabelText("文案模型 API Key"),
    "sk-validation-race-text",
  );
  await user.type(
    screen.getByLabelText("文案接口地址"),
    "https://api.openai.com/v1",
  );
  await user.click(screen.getByRole("button", { name: "测试文案模型" }));
  await waitFor(() => assert.ok(requestSignal));
  await user.clear(screen.getByLabelText("服务商"));
  await user.click(screen.getByRole("button", { name: "保存设置" }));

  await waitFor(() => {
    assert.equal(requestSignal?.aborted, true);
    assert.equal(
      screen.getByRole("status", { name: "GPT-5.6 连接状态" }).textContent,
      "未测试",
    );
    assert.equal(
      JSON.parse(
        window.localStorage.getItem("ai-workbench:model-registry:v2") ?? "[]",
      )[0]?.connectionStatus,
      "untested",
    );
  });

  pending.resolve(Response.json({ ok: true }));
  await waitFor(() => {
    assert.equal(
      screen.getByRole("status", { name: "GPT-5.6 连接状态" }).textContent,
      "未测试",
    );
    assert.doesNotMatch(
      window.localStorage.getItem("ai-workbench:model-credentials:v1") ?? "",
      /sk-validation-race-text/,
    );
  });
});

test("StrictMode effect replay keeps a current text probe eligible to complete", async () => {
  globalThis.fetch = (async () => Response.json({ ok: true })) as typeof fetch;
  const user = userEvent.setup({ document });
  render(
    <StrictMode>
      <Home />
    </StrictMode>,
  );

  await user.click(screen.getByRole("button", { name: "模型配置" }));
  await user.type(screen.getByLabelText("文案模型 API Key"), "sk-strict-mode-text");
  await user.type(
    screen.getByLabelText("文案接口地址"),
    "https://api.openai.com/v1",
  );
  await user.click(screen.getByRole("button", { name: "测试文案模型" }));

  await waitFor(() => {
    assert.equal(
      screen.getByRole("status", { name: "GPT-5.6 连接状态" }).textContent,
      "连接成功",
    );
  });
});

test("global image model test checks the model list without generating an image", async () => {
  const requestedUrls: string[] = [];
  globalThis.fetch = (async (input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    requestedUrls.push(url);
    return Response.json({ ok: true });
  }) as typeof fetch;
  const user = userEvent.setup({ document });
  render(<Home />);

  await user.click(screen.getByRole("button", { name: "模型配置" }));
  await user.type(screen.getByLabelText("生图模型 API Key"), "sk-fake-image-key");
  await user.type(screen.getByLabelText("生图接口地址"), "https://api.openai.com/v1");
  await user.type(screen.getByLabelText("生图模型名称"), "flux-test");
  const enabled = screen.getByRole("checkbox", { name: "启用生图模型" });
  assert.equal((enabled as HTMLInputElement).disabled, true);

  await user.click(screen.getByRole("button", { name: "测试生图模型" }));
  await waitFor(() => {
    assert.equal(
      screen.getByRole("status", { name: "生图模型连接状态" }).textContent,
      "连接成功",
    );
  });
  assert.deepEqual(requestedUrls, ["/api/models/test-image"]);
  assert.equal(requestedUrls.some((url) => url.includes("/images/generations")), false);
  assert.equal((enabled as HTMLInputElement).disabled, false);
});

test("saving during an image probe aborts it and persists a settled non-testing state", async () => {
  const pending = deferredValue<Response>();
  let requestSignal: AbortSignal | null = null;
  globalThis.fetch = (async (_input, init) => {
    requestSignal = init?.signal as AbortSignal;
    return pending.promise;
  }) as typeof fetch;
  const user = userEvent.setup({ document });
  render(<Home />);

  await user.click(screen.getByRole("button", { name: "模型配置" }));
  await user.type(screen.getByLabelText("生图模型 API Key"), "sk-save-race-image");
  await user.type(
    screen.getByLabelText("生图接口地址"),
    "https://api.openai.com/v1",
  );
  await user.type(screen.getByLabelText("生图模型名称"), "image-save-race");
  await user.click(screen.getByRole("button", { name: "测试生图模型" }));
  await waitFor(() => assert.ok(requestSignal));
  await user.click(screen.getByRole("button", { name: "保存设置" }));

  await waitFor(() => {
    assert.equal(requestSignal?.aborted, true);
    assert.equal(
      screen.getByRole("status", { name: "生图模型连接状态" }).textContent,
      "未测试",
    );
    assert.equal(
      JSON.parse(
        window.localStorage.getItem("ai-workbench:image-model-config:v1") ?? "null",
      ).connectionStatus,
      "untested",
    );
  });

  pending.resolve(Response.json({ ok: true }));
  await waitFor(() => {
    assert.equal(
      screen.getByRole("status", { name: "生图模型连接状态" }).textContent,
      "未测试",
    );
    assert.equal(
      JSON.parse(
        window.localStorage.getItem("ai-workbench:image-model-config:v1") ?? "null",
      ).connectionStatus,
      "untested",
    );
  });
});

test("text validation failure settles an aborted image retest and ignores the stale response", async () => {
  window.localStorage.setItem(
    "ai-workbench:image-model-config:v1",
    JSON.stringify({
      baseUrl: "https://api.openai.com/v1",
      modelId: "image-validation-race",
      enabled: true,
      connectionStatus: "connected",
      testedFingerprint:
        "[\"https://api.openai.com/v1\",\"image-validation-race\",\"revision-image-validation\"]",
    }),
  );
  window.localStorage.setItem(
    "ai-workbench:image-model-credential:v1",
    "sk-validation-race-image",
  );
  window.localStorage.setItem(
    "ai-workbench:image-model-credential-revision:v1",
    "revision-image-validation",
  );
  const pending = deferredValue<Response>();
  let requestSignal: AbortSignal | null = null;
  globalThis.fetch = (async (_input, init) => {
    requestSignal = init?.signal as AbortSignal;
    return pending.promise;
  }) as typeof fetch;
  const user = userEvent.setup({ document });
  render(<Home />);

  await user.click(screen.getByRole("button", { name: "模型配置" }));
  await waitFor(() => {
    assert.equal(
      screen.getByRole("status", { name: "生图模型连接状态" }).textContent,
      "连接成功",
    );
  });
  await user.click(screen.getByRole("button", { name: "测试生图模型" }));
  await waitFor(() => assert.ok(requestSignal));
  await user.clear(screen.getByLabelText("服务商"));
  await user.click(screen.getByRole("button", { name: "保存设置" }));

  await waitFor(() => {
    assert.equal(requestSignal?.aborted, true);
    assert.equal(
      screen.getByRole("status", { name: "生图模型连接状态" }).textContent,
      "连接成功",
    );
    assert.equal(
      JSON.parse(
        window.localStorage.getItem("ai-workbench:image-model-config:v1") ?? "null",
      ).connectionStatus,
      "connected",
    );
  });

  pending.resolve(Response.json({ ok: true }));
  await waitFor(() => {
    assert.equal(
      screen.getByRole("status", { name: "生图模型连接状态" }).textContent,
      "连接成功",
    );
    assert.equal(
      window.localStorage.getItem("ai-workbench:image-model-credential:v1"),
      "sk-validation-race-image",
    );
  });
});

test("editing or canceling an image draft aborts and ignores stale image probes", async () => {
  const editPending = deferredValue<Response>();
  const cancelPending = deferredValue<Response>();
  const requestSignals: AbortSignal[] = [];
  let callCount = 0;
  globalThis.fetch = (async (_input, init) => {
    requestSignals.push(init?.signal as AbortSignal);
    callCount += 1;
    return callCount === 1 ? editPending.promise : cancelPending.promise;
  }) as typeof fetch;
  const user = userEvent.setup({ document });
  render(<Home />);

  await user.click(screen.getByRole("button", { name: "模型配置" }));
  await user.type(screen.getByLabelText("生图模型 API Key"), "sk-stale-image-edit");
  await user.type(screen.getByLabelText("生图接口地址"), "https://api.openai.com/v1");
  await user.type(screen.getByLabelText("生图模型名称"), "image-old");
  await user.click(screen.getByRole("button", { name: "测试生图模型" }));
  await waitFor(() => assert.equal(callCount, 1));
  await user.type(screen.getByLabelText("生图模型名称"), "-changed");
  editPending.resolve(Response.json({ ok: true }));
  await waitFor(() => {
    assert.equal(
      screen.getByRole("status", { name: "生图模型连接状态" }).textContent,
      "配置已变更",
    );
  });
  assert.equal(requestSignals[0]?.aborted, true);

  await user.click(screen.getByRole("button", { name: /正在测试|测试生图模型/ }));
  await waitFor(() => assert.equal(callCount, 2));
  await user.click(screen.getByRole("button", { name: "取消" }));
  cancelPending.resolve(Response.json({ ok: true }));
  await waitFor(() => {
    assert.equal(
      screen.getByRole("status", { name: "生图模型连接状态" }).textContent,
      "未测试",
    );
  });
  assert.equal(requestSignals[1]?.aborted, true);
  assert.doesNotMatch(
    window.localStorage.getItem("ai-workbench:image-model-credential:v1") ?? "",
    /sk-stale-image-edit/,
  );
});

test("a newer image probe wins and an older failure cannot overwrite it", async () => {
  const first = deferredValue<Response>();
  const second = deferredValue<Response>();
  const requestSignals: AbortSignal[] = [];
  let callCount = 0;
  globalThis.fetch = (async (_input, init) => {
    requestSignals.push(init?.signal as AbortSignal);
    callCount += 1;
    return callCount === 1 ? first.promise : second.promise;
  }) as typeof fetch;
  const user = userEvent.setup({ document });
  render(<Home />);

  await user.click(screen.getByRole("button", { name: "模型配置" }));
  await user.type(screen.getByLabelText("生图模型 API Key"), "sk-retest-image");
  await user.type(screen.getByLabelText("生图接口地址"), "https://api.openai.com/v1");
  await user.type(screen.getByLabelText("生图模型名称"), "image-retest");
  await user.click(screen.getByRole("button", { name: "测试生图模型" }));
  await waitFor(() => assert.equal(callCount, 1));
  await user.click(screen.getByRole("button", { name: /正在测试|重新测试/ }));
  await waitFor(() => assert.equal(callCount, 2));
  second.resolve(Response.json({ ok: true }));
  await waitFor(() => {
    assert.equal(
      screen.getByRole("status", { name: "生图模型连接状态" }).textContent,
      "连接成功",
    );
  });
  first.resolve(
    Response.json({ ok: false, message: "旧图像请求失败" }, { status: 401 }),
  );
  await waitFor(() => {
    assert.equal(
      screen.getByRole("status", { name: "生图模型连接状态" }).textContent,
      "连接成功",
    );
  });
  assert.equal(requestSignals[0]?.aborted, true);
});

test("APINebula text testing uses the exact browser-direct chat probe", async () => {
  const requests: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = (async (input, init) => {
    requests.push({
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return Response.json({
      choices: [{ message: { content: "连接正常" } }],
    });
  }) as typeof fetch;
  const user = userEvent.setup({ document });
  render(<Home />);

  await user.click(screen.getByRole("button", { name: "模型配置" }));
  await user.type(screen.getByLabelText("文案模型 API Key"), "sk-fake-direct-text");
  await user.type(screen.getByLabelText("文案接口地址"), "https://apinebula.ai/v1");
  await user.click(screen.getByRole("button", { name: "测试文案模型" }));

  await waitFor(() => {
    assert.equal(
      screen.getByRole("status", { name: "GPT-5.6 连接状态" }).textContent,
      "连接成功",
    );
  });
  assert.equal(requests[0]?.url, "https://apinebula.ai/v1/chat/completions");
  assert.equal(
    (requests[0]?.body as { model?: string } | null)?.model,
    "gpt-5.6",
  );
  assert.equal(
    JSON.stringify(requests[0]?.body).includes("egressMode"),
    false,
  );
});

test("APINebula image testing uses the exact browser-direct models probe", async () => {
  const requestedUrls: string[] = [];
  globalThis.fetch = (async (input) => {
    requestedUrls.push(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    return Response.json({ data: [{ id: "flux-direct" }] });
  }) as typeof fetch;
  const user = userEvent.setup({ document });
  render(<Home />);

  await user.click(screen.getByRole("button", { name: "模型配置" }));
  await user.type(screen.getByLabelText("生图模型 API Key"), "sk-fake-direct-image");
  await user.type(screen.getByLabelText("生图接口地址"), "https://apinebula.ai/v1");
  await user.type(screen.getByLabelText("生图模型名称"), "flux-direct");
  await user.click(screen.getByRole("button", { name: "测试生图模型" }));

  await waitFor(() => {
    assert.equal(
      screen.getByRole("status", { name: "生图模型连接状态" }).textContent,
      "连接成功",
    );
  });
  assert.deepEqual(requestedUrls, ["https://apinebula.ai/v1/models"]);
  assert.equal(requestedUrls.some((url) => url.includes("/images/generations")), false);
});

test("saving global settings applies the final default model after all card drafts", async () => {
  window.localStorage.setItem(
    "ai-workbench:model-registry:v2",
    JSON.stringify([
      {
        id: "openai-gpt-5-6",
        provider: "OpenAI",
        displayName: "GPT-5.6",
        modelId: "gpt-5.6",
        baseUrl: "https://api.openai.com/v1",
        enabled: true,
        isDefault: true,
        connectionStatus: "connected",
        testedFingerprint:
          "[\"https://api.openai.com/v1\",\"gpt-5.6\",\"revision-default-primary\"]",
      },
      {
        id: "openai-gpt-secondary",
        provider: "OpenAI",
        displayName: "GPT Secondary",
        modelId: "gpt-secondary",
        baseUrl: "https://api.openai.com/v1",
        enabled: true,
        isDefault: false,
        connectionStatus: "connected",
        testedFingerprint:
          "[\"https://api.openai.com/v1\",\"gpt-secondary\",\"revision-default-secondary\"]",
      },
    ]),
  );
  window.localStorage.setItem(
    "ai-workbench:model-credentials:v1",
    JSON.stringify({
      "openai-gpt-5-6": "sk-default-primary",
      "openai-gpt-secondary": "sk-default-secondary",
    }),
  );
  window.localStorage.setItem(
    "ai-workbench:model-credential-revisions:v1",
    JSON.stringify({
      "openai-gpt-5-6": "revision-default-primary",
      "openai-gpt-secondary": "revision-default-secondary",
    }),
  );
  const user = userEvent.setup({ document });
  render(<Home />);

  await user.click(screen.getByRole("button", { name: "模型配置" }));
  const defaultRadios = screen.getAllByRole("radio", { name: "设为默认" });
  await user.click(defaultRadios[1]);
  await user.click(screen.getByRole("button", { name: "保存设置" }));

  await waitFor(() => {
    const stored = JSON.parse(
      window.localStorage.getItem("ai-workbench:model-registry:v2") ?? "[]",
    );
    assert.equal(
      stored.find((model: { isDefault?: boolean }) => model.isDefault)?.id,
      "openai-gpt-secondary",
    );
  });
});

test("keeps content matrix configuration separate while other Agents select enabled global models", async () => {
  window.localStorage.setItem(
    "ai-workbench:model-registry:v2",
    JSON.stringify([
      {
        id: "openai-gpt-5-6",
        provider: "OpenAI",
        displayName: "GPT-5.6",
        modelId: "gpt-5.6",
        baseUrl: "https://api.openai.com/v1",
        enabled: true,
        isDefault: true,
        connectionStatus: "connected",
        testedFingerprint:
          "[\"https://api.openai.com/v1\",\"gpt-5.6\",\"revision-agent-config\"]",
      },
    ]),
  );
  window.localStorage.setItem(
    "ai-workbench:model-credentials:v1",
    JSON.stringify({ "openai-gpt-5-6": "sk-agent-config" }),
  );
  window.localStorage.setItem(
    "ai-workbench:model-credential-revisions:v1",
    JSON.stringify({ "openai-gpt-5-6": "revision-agent-config" }),
  );
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

test("home chat keeps blank send disabled, fills a quick prompt, and shows the submitted turn immediately", async () => {
  installConnectedChatModels([
    {
      id: "chat-proxy",
      provider: "OpenAI",
      displayName: "真实聊天模型",
      modelId: "gpt-chat",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-chat-immediate",
      revision: "revision-chat-immediate",
    },
  ]);
  const pending = deferredValue<Response>();
  globalThis.fetch = (async () => pending.promise) as typeof fetch;
  const user = userEvent.setup({ document });
  render(<Home />);

  const input = screen.getByLabelText("聊天消息输入框");
  const send = screen.getByRole("button", { name: "发送" });
  await waitFor(() => assert.equal((send as HTMLButtonElement).disabled, true));
  await user.click(screen.getByRole("button", { name: "规划本月内容" }));
  assert.equal((input as HTMLTextAreaElement).value, "规划本月内容");
  assert.equal((send as HTMLButtonElement).disabled, false);

  await user.click(send);
  assert.ok(
    within(screen.getByLabelText("聊天记录")).getByText("规划本月内容"),
  );
  assert.equal((input as HTMLTextAreaElement).value, "");
  assert.equal((send as HTMLButtonElement).disabled, true);
  assert.ok(screen.getByRole("button", { name: "停止" }));
});

test("home chat sends exact APINebula models browser-direct and labels the real reply model", async () => {
  const apiKey = "sk-chat-direct-full-secret";
  installConnectedChatModels([
    {
      id: "chat-direct",
      provider: "APINebula",
      displayName: "Nebula GPT",
      modelId: "gpt-5.5",
      baseUrl: "https://apinebula.ai/v1",
      apiKey,
      revision: "revision-chat-direct",
    },
  ]);
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input, init) => {
    requests.push({
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      init,
    });
    return Response.json({
      choices: [{ message: { role: "assistant", content: "Nebula 真实回复" } }],
    });
  }) as typeof fetch;
  const user = userEvent.setup({ document });
  render(<Home />);

  await waitFor(() =>
    assert.ok(screen.getByRole("button", { name: "选择模型，当前 Nebula GPT" })),
  );
  await user.type(screen.getByLabelText("聊天消息输入框"), "直接请求");
  await user.click(screen.getByRole("button", { name: "发送" }));

  await waitFor(() => assert.ok(screen.getByText("Nebula 真实回复")));
  assert.equal(requests[0]?.url, "https://apinebula.ai/v1/chat/completions");
  assert.equal(
    new Headers(requests[0]?.init?.headers).get("authorization"),
    `Bearer ${apiKey}`,
  );
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
    model: "gpt-5.5",
    messages: [{ role: "user", content: "直接请求" }],
    max_tokens: 2048,
  });
  assert.ok(
    within(screen.getByLabelText("聊天记录")).getByText("Nebula GPT"),
  );
  assert.doesNotMatch(document.body.textContent ?? "", new RegExp(apiKey));
});

test("home chat proxies other models without an egress override and keeps conversation across model switches", async () => {
  installConnectedChatModels([
    {
      id: "chat-alpha",
      provider: "OpenAI",
      displayName: "Alpha 模型",
      modelId: "alpha-chat",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-chat-alpha",
      revision: "revision-chat-alpha",
    },
    {
      id: "chat-beta",
      provider: "OpenAI",
      displayName: "Beta 模型",
      modelId: "beta-chat",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-chat-beta",
      revision: "revision-chat-beta",
    },
  ]);
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      body,
    });
    return Response.json({
      ok: true,
      reply: requests.length === 1 ? "Alpha 回复" : "Beta 回复",
    });
  }) as typeof fetch;
  const user = userEvent.setup({ document });
  render(<Home />);

  await waitFor(() =>
    assert.ok(screen.getByRole("button", { name: "选择模型，当前 Alpha 模型" })),
  );
  await user.type(screen.getByLabelText("聊天消息输入框"), "第一问");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => assert.ok(screen.getByText("Alpha 回复")));

  await user.click(screen.getByRole("button", { name: "选择模型，当前 Alpha 模型" }));
  await user.click(screen.getByRole("button", { name: /Beta 模型/ }));
  assert.ok(screen.getByText("第一问"));
  assert.ok(screen.getByText("Alpha 回复"));
  await user.type(screen.getByLabelText("聊天消息输入框"), "第二问");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => assert.ok(screen.getByText("Beta 回复")));

  assert.deepEqual(requests.map((request) => request.url), [
    "/api/models/chat",
    "/api/models/chat",
  ]);
  assert.equal("egressMode" in requests[0].body, false);
  assert.deepEqual(requests[0].body, {
    config: {
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-chat-alpha",
      model: "alpha-chat",
    },
    turns: [{ role: "user", content: "第一问" }],
  });
  assert.deepEqual(
    within(screen.getByLabelText("聊天记录"))
      .getAllByText(/Alpha 模型|Beta 模型/)
      .map((node) => node.textContent),
    ["Alpha 模型", "Beta 模型"],
  );
});

test("home chat bounds history to complete exchanges plus the current user", async () => {
  installConnectedChatModels([
    {
      id: "chat-bounded",
      provider: "OpenAI",
      displayName: "上下文模型",
      modelId: "bounded-chat",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-chat-bounded",
      revision: "revision-chat-bounded",
    },
  ]);
  const histories: Array<Array<{ role: string; content: string }>> = [];
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      turns: Array<{ role: string; content: string }>;
    };
    histories.push(body.turns);
    return Response.json({ ok: true, reply: `回复 ${histories.length}` });
  }) as typeof fetch;
  const user = userEvent.setup({ document });
  render(<Home />);

  await waitFor(() =>
    assert.ok(screen.getByRole("button", { name: "选择模型，当前 上下文模型" })),
  );
  for (let index = 1; index <= 13; index += 1) {
    await user.type(screen.getByLabelText("聊天消息输入框"), `问题 ${index}`);
    await user.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => assert.ok(screen.getByText(`回复 ${index}`)));
  }

  assert.equal(histories.length, 13);
  assert.ok(histories.every((turns) => turns.length <= 20));
  assert.deepEqual(histories.at(-1), [
    { role: "user", content: "问题 4" },
    { role: "assistant", content: "回复 4" },
    { role: "user", content: "问题 5" },
    { role: "assistant", content: "回复 5" },
    { role: "user", content: "问题 6" },
    { role: "assistant", content: "回复 6" },
    { role: "user", content: "问题 7" },
    { role: "assistant", content: "回复 7" },
    { role: "user", content: "问题 8" },
    { role: "assistant", content: "回复 8" },
    { role: "user", content: "问题 9" },
    { role: "assistant", content: "回复 9" },
    { role: "user", content: "问题 10" },
    { role: "assistant", content: "回复 10" },
    { role: "user", content: "问题 11" },
    { role: "assistant", content: "回复 11" },
    { role: "user", content: "问题 12" },
    { role: "assistant", content: "回复 12" },
    { role: "user", content: "问题 13" },
  ]);
});

test("home chat omits an unanswered intermediate user instead of creating invalid role order", async () => {
  installConnectedChatModels([
    {
      id: "chat-unanswered",
      provider: "OpenAI",
      displayName: "顺序模型",
      modelId: "ordered-chat",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-chat-ordered",
      revision: "revision-chat-ordered",
    },
  ]);
  const firstPending = deferredValue<Response>();
  const histories: Array<Array<{ role: string; content: string }>> = [];
  let requestCount = 0;
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      turns: Array<{ role: string; content: string }>;
    };
    histories.push(body.turns);
    requestCount += 1;
    if (requestCount === 1) return firstPending.promise;
    return Response.json({ ok: true, reply: `有效回复 ${requestCount - 1}` });
  }) as typeof fetch;
  const user = userEvent.setup({ document });
  render(<Home />);

  await waitFor(() =>
    assert.ok(screen.getByRole("button", { name: "选择模型，当前 顺序模型" })),
  );
  await user.type(screen.getByLabelText("聊天消息输入框"), "未获回复的问题");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => assert.equal(requestCount, 1));
  await user.click(screen.getByRole("button", { name: "停止" }));

  await user.type(screen.getByLabelText("聊天消息输入框"), "有效问题 1");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => assert.ok(screen.getByText("有效回复 1")));
  await user.type(screen.getByLabelText("聊天消息输入框"), "有效问题 2");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => assert.ok(screen.getByText("有效回复 2")));

  assert.deepEqual(histories[2], [
    { role: "user", content: "有效问题 1" },
    { role: "assistant", content: "有效回复 1" },
    { role: "user", content: "有效问题 2" },
  ]);
});

test("home chat stop aborts and rejects a late reply without removing visible turns", async () => {
  installConnectedChatModels([
    {
      id: "chat-stop",
      provider: "OpenAI",
      displayName: "停止模型",
      modelId: "stop-chat",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-chat-stop",
      revision: "revision-chat-stop",
    },
  ]);
  const pending = deferredValue<Response>();
  let requestSignal: AbortSignal | null = null;
  globalThis.fetch = (async (_input, init) => {
    requestSignal = init?.signal as AbortSignal;
    return pending.promise;
  }) as typeof fetch;
  const user = userEvent.setup({ document });
  render(<Home />);

  await waitFor(() =>
    assert.ok(screen.getByRole("button", { name: "选择模型，当前 停止模型" })),
  );
  await user.type(screen.getByLabelText("聊天消息输入框"), "保留这条消息");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => assert.ok(requestSignal));
  await user.click(screen.getByRole("button", { name: "停止" }));

  assert.equal(requestSignal?.aborted, true);
  assert.ok(screen.getByText("保留这条消息"));
  assert.equal(screen.queryByRole("button", { name: "停止" }), null);
  pending.resolve(Response.json({ ok: true, reply: "不应出现的旧回复" }));
  await waitFor(() =>
    assert.equal(screen.queryByText("不应出现的旧回复"), null),
  );
});

test("home chat failure is safe and retry uses the currently selected model without duplicating the user turn", async () => {
  const firstKey = "sk-chat-failure-full-secret";
  const retryKey = "sk-chat-retry-full-secret";
  const rawProviderBody = `upstream exploded with ${firstKey}`;
  installConnectedChatModels([
    {
      id: "chat-failure",
      provider: "OpenAI",
      displayName: "失败模型",
      modelId: "failure-chat",
      baseUrl: "https://api.openai.com/v1",
      apiKey: firstKey,
      revision: "revision-chat-failure",
    },
    {
      id: "chat-retry",
      provider: "OpenAI",
      displayName: "重试模型",
      modelId: "retry-chat",
      baseUrl: "https://api.openai.com/v1",
      apiKey: retryKey,
      revision: "revision-chat-retry",
    },
  ]);
  const bodies: Array<{
    config: { apiKey: string; model: string };
    turns: Array<{ role: string; content: string }>;
  }> = [];
  globalThis.fetch = (async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    if (bodies.length === 1) {
      return Response.json(
        { ok: false, message: rawProviderBody },
        { status: 502 },
      );
    }
    return Response.json({ ok: true, reply: "安全重试成功" });
  }) as typeof fetch;
  const user = userEvent.setup({ document });
  render(<Home />);

  await waitFor(() =>
    assert.ok(screen.getByRole("button", { name: "选择模型，当前 失败模型" })),
  );
  await user.type(screen.getByLabelText("聊天消息输入框"), "只保留一次");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => assert.ok(screen.getByRole("button", { name: "重新发送" })));

  assert.equal(screen.getAllByText("只保留一次").length, 1);
  assert.doesNotMatch(document.body.textContent ?? "", new RegExp(firstKey));
  assert.doesNotMatch(document.body.textContent ?? "", new RegExp(rawProviderBody));
  await user.click(screen.getByRole("button", { name: "选择模型，当前 失败模型" }));
  await user.click(screen.getByRole("button", { name: /重试模型/ }));
  await user.click(screen.getByRole("button", { name: "重新发送" }));

  await waitFor(() => assert.ok(screen.getByText("安全重试成功")));
  assert.equal(screen.getAllByText("只保留一次").length, 1);
  assert.deepEqual(bodies.map((body) => body.config), [
    { baseUrl: "https://api.openai.com/v1", apiKey: firstKey, model: "failure-chat" },
    { baseUrl: "https://api.openai.com/v1", apiKey: retryKey, model: "retry-chat" },
  ]);
  assert.deepEqual(bodies[1]?.turns, [
    { role: "user", content: "只保留一次" },
  ]);
  assert.ok(
    within(screen.getByLabelText("聊天记录")).getByText("重试模型"),
  );
  assert.doesNotMatch(document.body.textContent ?? "", new RegExp(retryKey));
});

test("home chat stop during retry preserves retry state for another successful attempt", async () => {
  installConnectedChatModels([
    {
      id: "chat-retry-stop",
      provider: "OpenAI",
      displayName: "可恢复模型",
      modelId: "retry-stop-chat",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-chat-retry-stop",
      revision: "revision-chat-retry-stop",
    },
  ]);
  const retryPending = deferredValue<Response>();
  const requestSignals: AbortSignal[] = [];
  const turns: Array<Array<{ role: string; content: string }>> = [];
  let requestCount = 0;
  globalThis.fetch = (async (_input, init) => {
    requestCount += 1;
    requestSignals.push(init?.signal as AbortSignal);
    turns.push(
      (JSON.parse(String(init?.body)) as {
        turns: Array<{ role: string; content: string }>;
      }).turns,
    );
    if (requestCount === 1) {
      return Response.json({ ok: false }, { status: 502 });
    }
    if (requestCount === 2) return retryPending.promise;
    return Response.json({ ok: true, reply: "再次重试成功" });
  }) as typeof fetch;
  const user = userEvent.setup({ document });
  render(<Home />);

  await waitFor(() =>
    assert.ok(screen.getByRole("button", { name: "选择模型，当前 可恢复模型" })),
  );
  await user.type(screen.getByLabelText("聊天消息输入框"), "需要恢复的消息");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => assert.ok(screen.getByRole("button", { name: "重新发送" })));

  await user.click(screen.getByRole("button", { name: "重新发送" }));
  await waitFor(() => assert.equal(requestCount, 2));
  assert.equal(
    (screen.getByRole("button", { name: "重新发送" }) as HTMLButtonElement)
      .disabled,
    true,
  );
  await user.click(screen.getByRole("button", { name: "停止" }));

  assert.equal(requestSignals[1]?.aborted, true);
  assert.equal(
    (screen.getByRole("button", { name: "重新发送" }) as HTMLButtonElement)
      .disabled,
    false,
  );
  await user.click(screen.getByRole("button", { name: "重新发送" }));
  await waitFor(() => assert.ok(screen.getByText("再次重试成功")));

  assert.equal(requestCount, 3);
  assert.equal(screen.getAllByText("需要恢复的消息").length, 1);
  assert.deepEqual(turns, [
    [{ role: "user", content: "需要恢复的消息" }],
    [{ role: "user", content: "需要恢复的消息" }],
    [{ role: "user", content: "需要恢复的消息" }],
  ]);
  assert.equal(screen.queryByRole("button", { name: "重新发送" }), null);
});

test("home chat blocks ordinary sends while a failed turn still needs retry", async () => {
  installConnectedChatModels([
    {
      id: "chat-failed-lock",
      provider: "OpenAI",
      displayName: "失败锁定模型",
      modelId: "failed-lock-chat",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-chat-failed-lock",
      revision: "revision-chat-failed-lock",
    },
  ]);
  let requestCount = 0;
  globalThis.fetch = (async () => {
    requestCount += 1;
    return Response.json({ ok: false }, { status: 502 });
  }) as typeof fetch;
  const user = userEvent.setup({ document });
  render(<Home />);

  await waitFor(() =>
    assert.ok(
      screen.getByRole("button", { name: "选择模型，当前 失败锁定模型" }),
    ),
  );
  await user.type(screen.getByLabelText("聊天消息输入框"), "首次失败");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => assert.ok(screen.getByRole("button", { name: "重新发送" })));

  await user.type(screen.getByLabelText("聊天消息输入框"), "不应另发");
  const send = screen.getByRole("button", { name: "发送" });
  assert.equal((send as HTMLButtonElement).disabled, true);
  (send as HTMLButtonElement).click();
  assert.equal(requestCount, 1);
  assert.equal(
    within(screen.getByLabelText("聊天记录")).queryByText("不应另发"),
    null,
  );
});

test("leaving home chat aborts its active request and ignores its completion", async () => {
  installConnectedChatModels([
    {
      id: "chat-unmount",
      provider: "OpenAI",
      displayName: "卸载模型",
      modelId: "unmount-chat",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-chat-unmount",
      revision: "revision-chat-unmount",
    },
  ]);
  const pending = deferredValue<Response>();
  let requestSignal: AbortSignal | null = null;
  globalThis.fetch = (async (_input, init) => {
    requestSignal = init?.signal as AbortSignal;
    return pending.promise;
  }) as typeof fetch;
  const user = userEvent.setup({ document });
  render(<Home />);

  await waitFor(() =>
    assert.ok(screen.getByRole("button", { name: "选择模型，当前 卸载模型" })),
  );
  await user.type(screen.getByLabelText("聊天消息输入框"), "卸载前请求");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => assert.ok(requestSignal));
  await user.click(screen.getByRole("button", { name: "Agent 项目" }));

  assert.equal(requestSignal?.aborted, true);
  pending.resolve(Response.json({ ok: true, reply: "卸载后的旧回复" }));
  await waitFor(() => assert.equal(screen.queryByText("卸载后的旧回复"), null));
});

test("home chat and Agent A and B keep independent model selections", async () => {
  window.localStorage.setItem(
    "ai-workbench:model-registry:v2",
    JSON.stringify([
      {
        id: "openai-gpt-5-6",
        provider: "OpenAI",
        displayName: "GPT-5.6",
        modelId: "gpt-5.6",
        baseUrl: "https://api.openai.com/v1",
        enabled: true,
        isDefault: true,
        connectionStatus: "connected",
        testedFingerprint:
          "[\"https://api.openai.com/v1\",\"gpt-5.6\",\"revision-chat-openai\"]",
      },
      {
        id: "anthropic-claude",
        provider: "Anthropic",
        displayName: "Claude Sonnet",
        modelId: "claude-sonnet",
        baseUrl: "https://api.openai.com/v1",
        enabled: true,
        isDefault: false,
        connectionStatus: "connected",
        testedFingerprint:
          "[\"https://api.openai.com/v1\",\"claude-sonnet\",\"revision-chat-claude\"]",
      },
      {
        id: "google-gemini",
        provider: "Google",
        displayName: "Gemini Pro",
        modelId: "gemini-pro",
        baseUrl: "https://api.openai.com/v1",
        enabled: true,
        isDefault: false,
        connectionStatus: "connected",
        testedFingerprint:
          "[\"https://api.openai.com/v1\",\"gemini-pro\",\"revision-chat-gemini\"]",
      },
    ]),
  );
  window.localStorage.setItem(
    "ai-workbench:model-credentials:v1",
    JSON.stringify({
      "openai-gpt-5-6": "sk-chat-openai",
      "anthropic-claude": "sk-chat-claude",
      "google-gemini": "sk-chat-gemini",
    }),
  );
  window.localStorage.setItem(
    "ai-workbench:model-credential-revisions:v1",
    JSON.stringify({
      "openai-gpt-5-6": "revision-chat-openai",
      "anthropic-claude": "revision-chat-claude",
      "google-gemini": "revision-chat-gemini",
    }),
  );
  const user = userEvent.setup({ document });
  render(<Home />);

  await waitFor(() => {
    assert.ok(screen.getByRole("button", { name: /选择模型，当前 GPT-5\.6/ }));
  });
  await user.click(screen.getByRole("button", { name: /选择模型，当前 GPT-5\.6/ }));
  await user.click(screen.getByRole("button", { name: /Claude Sonnet/ }));

  await user.click(screen.getByRole("button", { name: "Agent 项目" }));
  await user.click(screen.getByRole("button", { name: /竞品洞察 Agent/ }));
  await user.click(screen.getByRole("button", { name: "Agent 配置" }));
  assert.equal(
    (screen.getByRole("radio", { name: /GPT-5\.6 OpenAI/ }) as HTMLInputElement)
      .checked,
    true,
  );
  await user.click(screen.getByRole("radio", { name: /Gemini Pro Google/ }));

  await user.click(screen.getByRole("button", { name: "← 返回 Agent 项目" }));
  await user.click(screen.getByRole("button", { name: /选题策划 Agent/ }));
  await user.click(screen.getByRole("button", { name: "Agent 配置" }));
  assert.equal(
    (screen.getByRole("radio", { name: /GPT-5\.6 OpenAI/ }) as HTMLInputElement)
      .checked,
    true,
  );

  await user.click(screen.getByRole("button", { name: "AI 对话" }));
  assert.ok(
    screen.getByRole("button", { name: "选择模型，当前 Claude Sonnet" }),
  );

  await user.click(screen.getByRole("button", { name: "Agent 项目" }));
  await user.click(screen.getByRole("button", { name: /竞品洞察 Agent/ }));
  await user.click(screen.getByRole("button", { name: "Agent 配置" }));
  assert.equal(
    (screen.getByRole("radio", { name: /Gemini Pro Google/ }) as HTMLInputElement)
      .checked,
    true,
  );
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
