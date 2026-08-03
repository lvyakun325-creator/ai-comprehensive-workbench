import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import { JSDOM } from "jsdom";
import type {
  ProjectBundle,
  ProjectResult,
  ProjectTask,
  TaskStatusFilter,
} from "../app/lib/agent-project-records.mjs";
import type {
  ChatSession,
  ChatSessionHistoryItem,
} from "../app/lib/chat-session-store.mjs";
import type { CompetitorAnalysisRequest } from "../app/components/CompetitorReportRunner";

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

const { act, cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const { default: userEvent } = await import("@testing-library/user-event");
const { within } = await import("@testing-library/dom");
const { StrictMode, useState } = await import("react");
const { AGENT_PROJECTS } = await import("../app/lib/agent-catalog.mjs");
const { AgentResultFiles } = await import("../app/components/AgentResultFiles");
const { CompetitorResultBundles } = await import(
  "../app/components/CompetitorResultBundles"
);
const { AgentTaskList } = await import("../app/components/AgentTaskList");
const { CompetitorInsightPanel } = await import(
  "../app/components/CompetitorInsightPanel"
);
const { ChatHistorySidebar } = await import(
  "../app/components/ChatHistorySidebar"
);
const { ChatTranscript } = await import("../app/components/ChatTranscript");
const { default: Home } = await import("../app/page");
const {
  ModelRegistryProvider,
  useModelRegistry,
} = await import("../app/components/ModelRegistryProvider");
const { CompetitorReportRunner } = await import(
  "../app/components/CompetitorReportRunner"
);
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

function assertSignalAborted(signal: AbortSignal | null) {
  assert.ok(signal);
  assert.equal(signal.aborted, true);
}

function assertSignalNotAborted(signal: AbortSignal | null) {
  assert.ok(signal);
  assert.equal(signal.aborted, false);
}

function readIndexedDbRequest<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), {
      once: true,
    });
    request.addEventListener(
      "error",
      () => reject(request.error ?? new Error("IndexedDB read failed")),
      { once: true },
    );
  });
}

async function snapshotIndexedDb(factory: IDBFactory) {
  const databaseInfos = await factory.databases();
  const snapshots: Array<{
    database: string;
    store: string;
    keys: IDBValidKey[];
    values: unknown[];
  }> = [];

  for (const databaseInfo of databaseInfos) {
    if (!databaseInfo.name) continue;
    const database = await readIndexedDbRequest(factory.open(databaseInfo.name));
    try {
      for (const storeName of Array.from(database.objectStoreNames)) {
        const transaction = database.transaction(storeName, "readonly");
        const store = transaction.objectStore(storeName);
        const [keys, values] = await Promise.all([
          readIndexedDbRequest(store.getAllKeys()),
          readIndexedDbRequest(store.getAll()),
        ]);
        snapshots.push({
          database: databaseInfo.name,
          store: storeName,
          keys,
          values,
        });
      }
    } finally {
      database.close();
    }
  }

  const seen = new WeakSet<object>();
  return JSON.stringify(snapshots, (_key, value: unknown) => {
    if (typeof value === "bigint") return value.toString();
    if (value && typeof value === "object") {
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
    }
    return value;
  });
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
  window.sessionStorage.clear();
  createdMarkdownBlobs.length = 0;
  revokedMarkdownUrls.length = 0;
  clickedDownloadAnchors.length = 0;
  globalThis.fetch = originalFetch;
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 1024,
  });
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

test("竞品任务卡展示平台、Skill 与清理后的项目链接", () => {
  const task: ProjectTask = {
    ...taskStateFixtures[2],
    id: "competitor-20260801-card-a1",
    agentId: "competitor-insight",
    title: "小红书作品抓取",
    platformId: "xiaohongshu",
    platformLabel: "小红书",
    skillId: "xiaohongshu-scraper",
    sourceUrl: "https://www.xiaohongshu.com/explore/abc",
  };
  const artifact: ProjectResult = {
    ...resultFileFixtures[0],
    id: "artifact-0000000000000011",
    agentId: "competitor-insight",
    taskId: task.id,
    filename: "result.xlsx",
    kind: "excel",
    absolutePath: "/controlled/result.xlsx",
    markdown: null,
  };

  render(
    <AgentTaskList
      agentId="competitor-insight"
      filter="all"
      getAgentTasks={() => [task]}
      getTaskResults={() => [artifact]}
      onFilterChange={() => undefined}
      onOpenResult={() => undefined}
    />,
  );

  assert.ok(screen.getByText("小红书"));
  assert.ok(screen.getByText("xiaohongshu-scraper"));
  const link = screen.getByRole("link", {name: "查看抓取链接"});
  assert.equal(link.getAttribute("href"), task.sourceUrl);
  assert.equal(link.getAttribute("target"), "_blank");
  assert.doesNotMatch(link.getAttribute("href") ?? "", /token|source/iu);
});

function competitorBundleUiFixture(
  overrides: Partial<ProjectBundle> = {},
) {
  const taskId = "competitor-20260801-ui-a1";
  const bundleId = "bundle-00000000000000a1";
  const artifact: ProjectResult = {
    id: "artifact-00000000000000a1",
    agentId: "competitor-insight",
    taskId,
    filename: "current-report.md",
    completedAt: "2026-08-01T02:02:00.000Z",
    sizeBytes: 512,
    markdown: null,
    kind: "markdown",
    absolutePath: `/controlled/${taskId}/current-report.md`,
    exists: true,
    isDirectory: false,
    previewable: true,
  };
  const bundle: ProjectBundle = {
    id: bundleId,
    agentId: "competitor-insight",
    taskId,
    platformId: "xiaohongshu",
    platformLabel: "小红书",
    inputKind: "content",
    category: "xhs-note",
    title: "小红书笔记分析成果包",
    subjectName: "测试作者",
    sourceUrl: "https://www.xiaohongshu.com/explore/test-note?token=hidden",
    status: "ready",
    primaryArtifactId: artifact.id,
    manifestPath: `/controlled/${taskId}/${bundleId}.manifest.json`,
    archivePath: `/controlled/${taskId}/${bundleId}.zip`,
    rootDirectory: `/controlled/${taskId}`,
    artifactIds: [artifact.id],
    itemCount: 1,
    createdAt: "2026-08-01T02:01:00.000Z",
    completedAt: "2026-08-01T02:02:00.000Z",
    ...overrides,
  };
  return {artifact, bundle};
}

function renderCompetitorBundleFixture(
  overrides: Partial<ProjectBundle> = {},
  onPreview: (message: string) => void = () => undefined,
) {
  const fixture = competitorBundleUiFixture(overrides);
  return {
    ...fixture,
    view: render(
      <CompetitorResultBundles
        artifacts={[fixture.artifact]}
        bundles={[fixture.bundle]}
        onPreview={onPreview}
      />,
    ),
  };
}

test("竞品成果每任务一张成果包卡片并支持分类与默认折叠", async () => {
  const snapshot = competitorWorkspaceSnapshot();
  globalThis.fetch = withCompetitorHealth(async (input, init) => {
    const url = String(input);
    if (url.includes("/project-records") && (init?.method ?? "GET") === "GET") {
      return Response.json(snapshot);
    }
    throw new Error(`unexpected request: ${url}`);
  });
  const user = userEvent.setup({document});
  render(<Home />);

  await user.click(screen.getByRole("button", {name: "Agent 项目"}));
  await user.click(screen.getByRole("button", {name: /竞品洞察 Agent/}));
  await user.click(screen.getByRole("button", {name: "成果文件"}));

  await waitFor(() => {
    assert.equal(
      screen.getAllByRole("article", {name: /成果包/}).length,
      2,
    );
  });
  assert.ok(screen.getByRole("heading", {name: "小红书笔记分析成果包"}));
  assert.ok(screen.getByRole("heading", {name: "历史抖音账号成果包"}));
  assert.ok(screen.getByRole("button", {name: "小红书笔记"}));
  assert.ok(screen.getByRole("button", {name: "抖音账号"}));
  assert.ok(screen.getByText("current-report.md"));
  assert.equal(screen.queryByText("原始数据.xlsx"), null);
  assert.doesNotMatch(document.body.textContent ?? "", /query-secret|token=/u);
  const sourceLink = screen.getByRole("link", {name: "查看来源链接：测试作者"});
  assert.equal(sourceLink.getAttribute("href"), "https://www.xiaohongshu.com/explore/test-note");

  const currentBundleCard = screen.getByRole("article", {
    name: "小红书笔记分析成果包 成果包",
  });
  await user.click(within(currentBundleCard).getByRole("button", {
    name: "展开明细",
  }));
  assert.ok(screen.getByText("原始数据.xlsx"));
  assert.ok(screen.getByText("structured-data.json"));

  await user.click(screen.getByRole("button", {name: "小红书笔记"}));
  assert.ok(screen.getByRole("heading", {name: "小红书笔记分析成果包"}));
  assert.equal(screen.queryByRole("heading", {name: "历史抖音账号成果包"}), null);
  await user.click(screen.getByRole("button", {name: "全部成果"}));
  assert.ok(screen.getByRole("heading", {name: "历史抖音账号成果包"}));
});

test("竞品成果包只在点击后预览下载和按 bundleId 定位", async () => {
  const snapshot = competitorWorkspaceSnapshot();
  const currentBundle = snapshot.bundles[0];
  const currentTask = snapshot.tasks[0];
  const currentArtifacts = snapshot.artifacts.filter(
    (artifact) => artifact.taskId === currentTask.id,
  );
  const requests: Array<{url: string; method: string}> = [];
  globalThis.fetch = withCompetitorHealth(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push({url, method});
    if (url.includes("/project-records") && method === "GET") {
      return Response.json(snapshot);
    }
    if (url.endsWith(`/project-bundles/${currentBundle.id}`) && method === "GET") {
      return Response.json({
        ok: true,
        bundle: currentBundle,
        task: currentTask,
        artifacts: currentArtifacts,
        markdown: "# 本次竞品分析\n\n按需加载的报告正文。",
        previewable: true,
      });
    }
    if (url.endsWith(`/project-bundles/${currentBundle.id}/download`) && method === "GET") {
      const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
      return new Response(bytes, {
        status: 200,
        headers: {
          "content-disposition": 'attachment; filename="current-bundle.zip"',
          "content-length": String(bytes.byteLength),
          "content-type": "application/zip",
        },
      });
    }
    if (url.endsWith(`/project-bundles/${currentBundle.id}/reveal`) && method === "POST") {
      return Response.json({ok: true, bundleId: currentBundle.id});
    }
    throw new Error(`unexpected request: ${method} ${url}`);
  });
  const user = userEvent.setup({document});
  render(<Home />);

  await user.click(screen.getByRole("button", {name: "Agent 项目"}));
  await user.click(screen.getByRole("button", {name: /竞品洞察 Agent/}));
  await user.click(screen.getByRole("button", {name: "成果文件"}));
  await screen.findByRole("heading", {name: "小红书笔记分析成果包"});
  assert.equal(requests.some(({url}) => url.includes("/project-bundles/")), false);

  const currentBundleCard = screen.getByRole("article", {
    name: "小红书笔记分析成果包 成果包",
  });
  await user.click(within(currentBundleCard).getByRole("button", {name: "查看分析报告"}));
  assert.ok(await screen.findByRole("region", {name: "小红书笔记分析成果包报告预览"}));
  assert.match(document.body.textContent ?? "", /按需加载的报告正文/u);
  assert.equal(
    requests.filter(({url, method}) => url.endsWith(`/project-bundles/${currentBundle.id}`) && method === "GET").length,
    1,
  );

  await user.click(within(currentBundleCard).getByRole("button", {name: "下载成果包"}));
  await waitFor(() => assert.equal(clickedDownloadAnchors.length, 1));
  assert.equal(clickedDownloadAnchors[0].download, "current-bundle.zip");
  assert.equal(createdMarkdownBlobs.at(-1)?.blob.type, "application/zip");
  assert.deepEqual(revokedMarkdownUrls, [createdMarkdownBlobs.at(-1)?.url]);

  await user.click(within(currentBundleCard).getByRole("button", {name: "在访达中显示"}));
  await waitFor(() => {
    assert.equal(
      requests.filter(({url, method}) => url.endsWith(`/project-bundles/${currentBundle.id}/reveal`) && method === "POST").length,
      1,
    );
  });
  assert.match(screen.getByRole("status", {name: "成果包操作状态"}).textContent ?? "", /已在访达中显示/u);
});

test("v1 legacy 快照保留成果卡且详情惰性下载与刷新后下载可用", async () => {
  const taskId = "competitor-20260801-legacy-ui";
  const bundleId = "bundle-0000000000000001";
  const artifactId = "artifact-0000000000000001";
  const root = "/controlled/outputs/competitor-insight/xiaohongshu/legacy-export";
  const reportPath = `${root}/legacy-report.md`;
  const task = {
    ...persistedCompetitorTask("completed", 100, {
      inputKind: "unknown",
      category: null,
      bundleId,
    }, taskId),
    title: "v1 历史成果包",
    artifactIds: [artifactId],
  };
  const artifact = {
    id: artifactId,
    agentId: "competitor-insight",
    taskId,
    kind: "markdown",
    filename: "legacy-report.md",
    absolutePath: reportPath,
    sizeBytes: 128,
    completedAt: task.completedAt,
    previewable: true,
    exists: true,
    isDirectory: false,
    markdown: null,
  };
  const bundle = {
    id: bundleId,
    agentId: "competitor-insight",
    taskId,
    platformId: "xiaohongshu",
    inputKind: "unknown",
    category: null,
    subjectName: task.title,
    itemCount: 0,
    status: "legacy",
    rootDirectory: root,
    primaryReportPath: reportPath,
    manifestPath: `${root}/${bundleId}.manifest.json`,
    archivePath: `${root}/${bundleId}.zip`,
    artifactIds: [artifactId],
    manifestSha256: null,
    archiveSha256: null,
    memberIdentitySha256: null,
    createdAt: task.completedAt,
    updatedAt: task.updatedAt,
  };
  const snapshot = {ok: true, tasks: [task], artifacts: [artifact], bundles: [bundle]};
  const requests: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("/health")) return competitorHealthResponse(url);
    if (url.includes("/project-records")) return Response.json(snapshot);
    if (url.endsWith(`/project-bundles/${bundleId}`)) {
      return Response.json({
        ok: true,
        bundle,
        task,
        artifacts: [artifact],
        markdown: "# v1 历史报告\n\n首次按需物化成功。",
        previewable: true,
      });
    }
    if (url.endsWith(`/project-bundles/${bundleId}/download`)) {
      const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
      return new Response(bytes, {headers: {
        "content-disposition": 'attachment; filename="legacy-bundle.zip"',
        "content-length": String(bytes.byteLength),
        "content-type": "application/zip",
      }});
    }
    throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url}`);
  }) as typeof fetch;
  const user = userEvent.setup({document});
  render(<Home />);
  await user.click(screen.getByRole("button", {name: "Agent 项目"}));
  await user.click(screen.getByRole("button", {name: /竞品洞察 Agent/}));
  await user.click(screen.getByRole("button", {name: "成果文件"}));
  const card = await screen.findByRole("article", {name: "v1 历史成果包 成果包"});
  requests.length = 0;

  await user.click(within(card).getByRole("button", {name: "查看分析报告"}));
  assert.match((await screen.findByRole("region", {name: "v1 历史成果包报告预览"})).textContent ?? "", /首次按需物化成功/u);
  await user.click(within(card).getByRole("button", {name: "下载成果包"}));
  await waitFor(() => assert.equal(clickedDownloadAnchors.at(-1)?.download, "legacy-bundle.zip"));
  assert.deepEqual(requests, [
    "http://127.0.0.1:8768/health",
    `http://127.0.0.1:8768/project-bundles/${bundleId}`,
    "http://127.0.0.1:8768/health",
    `http://127.0.0.1:8768/project-bundles/${bundleId}/download`,
  ]);

  await user.click(screen.getByRole("button", {name: "成果文件"}));
  await waitFor(() => assert.equal(
    requests.filter((url) => url.includes("/project-records")).length,
    1,
  ));
  const refreshedCard = screen.getByRole("article", {name: "v1 历史成果包 成果包"});
  const downloadsBeforeRefreshClick = clickedDownloadAnchors.length;
  await user.click(within(refreshedCard).getByRole("button", {name: "下载成果包"}));
  await waitFor(() => assert.equal(clickedDownloadAnchors.length, downloadsBeforeRefreshClick + 1));
  assert.equal(clickedDownloadAnchors.at(-1)?.download, "legacy-bundle.zip");
  assert.equal(
    requests.filter((url) => url.endsWith(`/project-bundles/${bundleId}/download`)).length,
    2,
  );
});

test("竞品成果包统一清理 title subject source 及所有无障碍名称中的敏感片段", async () => {
  const snapshot = competitorWorkspaceSnapshot();
  snapshot.tasks[0].title = "竞品 https://title-user:title-pass@example.com/item?token=title-secret#title-fragment credential=title-credential";
  snapshot.tasks[0].sourceUrl = "https://www.xiaohongshu.com/explore/test-note?token=source-secret#source-fragment";
  snapshot.bundles[0].subjectName = "作者 https://subject-user:subject-pass@example.com/profile?cookie=subject-secret#subject-fragment cookie=subject-cookie";
  const currentBundle = snapshot.bundles[0];
  const currentTask = snapshot.tasks[0];
  const currentArtifacts = snapshot.artifacts.filter((artifact) => artifact.taskId === currentTask.id);
  globalThis.fetch = withCompetitorHealth(async (input, init) => {
    const url = String(input);
    if (url.includes("/project-records")) return Response.json(snapshot);
    if (url.endsWith(`/project-bundles/${currentBundle.id}`)) {
      return Response.json({
        ok: true,
        bundle: currentBundle,
        task: currentTask,
        artifacts: currentArtifacts,
        markdown: "# 安全报告",
        previewable: true,
      });
    }
    if (url.endsWith(`/project-bundles/${currentBundle.id}/reveal`) && init?.method === "POST") {
      return Response.json({ok: false, error: "INTERNAL_ERROR", debug: "status-secret"}, {status: 500});
    }
    throw new Error(`unexpected request: ${url}`);
  });
  const user = userEvent.setup({document});
  render(<Home />);

  await user.click(screen.getByRole("button", {name: "Agent 项目"}));
  await user.click(screen.getByRole("button", {name: /竞品洞察 Agent/}));
  await user.click(screen.getByRole("button", {name: "成果文件"}));
  const article = await screen.findByRole("article", {name: /竞品 https:\/\/example\.com\/item.*成果包/u});
  const sourceLink = within(article).getByRole("link", {name: /查看来源链接/u});
  assert.equal(sourceLink.getAttribute("href"), "https://www.xiaohongshu.com/explore/test-note");
  assert.doesNotMatch(document.body.innerHTML, /title-secret|title-pass|title-credential|subject-secret|subject-pass|subject-cookie|source-secret|status-secret/u);

  await user.click(within(article).getByRole("button", {name: "查看分析报告"}));
  assert.ok(await screen.findByRole("region", {name: /竞品 https:\/\/example\.com\/item.*报告预览/u}));
  await user.click(within(article).getByRole("button", {name: "在访达中显示"}));
  await waitFor(() => assert.match(screen.getByRole("status", {name: "成果包操作状态"}).textContent ?? "", /无法/u));
  assert.doesNotMatch(document.body.innerHTML, /title-secret|title-pass|title-credential|subject-secret|subject-pass|subject-cookie|source-secret|status-secret/u);
});

test("竞品合法 URL 括号查询与片段不进入 DOM aria 或状态", async () => {
  renderCompetitorBundleFixture({
    title: "竞品 https://example.com/item?token=(query-secret)#fragment-secret",
  });
  const article = screen.getByRole("article", {
    name: "竞品 https://example.com/item 成果包",
  });

  assert.ok(screen.getByRole("heading", {
    name: "竞品 https://example.com/item",
  }));
  assert.doesNotMatch(document.body.innerHTML, /query-secret|fragment-secret/u);

  await userEvent.setup({document}).click(
    within(article).getByRole("button", {name: "展开明细"}),
  );
  assert.equal(
    screen.getByRole("status", {name: "成果包界面状态"}).textContent,
    "竞品 https://example.com/item明细已展开",
  );
  assert.doesNotMatch(document.body.innerHTML, /query-secret|fragment-secret/u);
});

test("竞品 URL 查询中的 ASCII 逗号不会将密钥后缀泄露到 DOM aria 或状态", async () => {
  renderCompetitorBundleFixture({
    title: "逗号 https://example.com/item?token=first,query-secret#fragment-secret",
  });
  const article = screen.getByRole("article", {
    name: "逗号 https://example.com/item 成果包",
  });

  assert.ok(screen.getByRole("heading", {name: "逗号 https://example.com/item"}));
  assert.doesNotMatch(document.body.innerHTML, /query-secret|fragment-secret/u);
  await userEvent.setup({document}).click(
    within(article).getByRole("button", {name: "展开明细"}),
  );
  assert.equal(
    screen.getByRole("status", {name: "成果包界面状态"}).textContent,
    "逗号 https://example.com/item明细已展开",
  );
  assert.doesNotMatch(document.body.innerHTML, /query-secret|fragment-secret/u);
});

test("竞品 URL 查询中的 ASCII 分号不会将密钥后缀泄露到 DOM aria 或状态", async () => {
  renderCompetitorBundleFixture({
    title: "分号 https://example.com/item?token=first;query-secret#fragment-secret",
  });
  const article = screen.getByRole("article", {
    name: "分号 https://example.com/item 成果包",
  });

  assert.ok(screen.getByRole("heading", {name: "分号 https://example.com/item"}));
  assert.doesNotMatch(document.body.innerHTML, /query-secret|fragment-secret/u);
  await userEvent.setup({document}).click(
    within(article).getByRole("button", {name: "展开明细"}),
  );
  assert.equal(
    screen.getByRole("status", {name: "成果包界面状态"}).textContent,
    "分号 https://example.com/item明细已展开",
  );
  assert.doesNotMatch(document.body.innerHTML, /query-secret|fragment-secret/u);
});

test("竞品 Authorization Bearer 凭据完整隐藏且保留后续正常中文", () => {
  renderCompetitorBundleFixture({
    subjectName: "作者 authorization: Bearer auth-secret，后续正常中文",
  });

  assert.ok(screen.getByText("作者 [敏感信息已隐藏]，后续正常中文"));
  assert.ok(screen.getByRole("link", {
    name: "查看来源链接：作者 [敏感信息已隐藏]，后续正常中文",
  }));
  assert.doesNotMatch(document.body.innerHTML, /auth-secret/u);
});

test("竞品普通中文标题与主体原样展示", async () => {
  renderCompetitorBundleFixture({
    title: "普通中文标题",
    subjectName: "普通中文作者",
  });
  const article = screen.getByRole("article", {name: "普通中文标题 成果包"});

  assert.ok(screen.getByRole("heading", {name: "普通中文标题"}));
  assert.ok(within(article).getByText("普通中文作者"));
  await userEvent.setup({document}).click(
    within(article).getByRole("button", {name: "展开明细"}),
  );
  assert.equal(
    screen.getByRole("status", {name: "成果包界面状态"}).textContent,
    "普通中文标题明细已展开",
  );
});

test("竞品成果包三类动作使用稳定名称并同步阻止同一渲染内重复激活", async () => {
  const snapshot = competitorWorkspaceSnapshot();
  const detail = deferredValue<Response>();
  const download = deferredValue<Response>();
  const reveal = deferredValue<Response>();
  const requests: string[] = [];
  globalThis.fetch = withCompetitorHealth(async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("/download")) return download.promise;
    if (url.endsWith("/reveal")) return reveal.promise;
    return detail.promise;
  });
  const {bundle} = renderCompetitorBundleFixture();
  const article = screen.getByRole("article", {name: `${bundle.title} 成果包`});
  const reportButton = within(article).getByRole("button", {name: "查看分析报告"});

  act(() => {
    reportButton.dispatchEvent(new dom.window.MouseEvent("click", {bubbles: true}));
    reportButton.dispatchEvent(new dom.window.MouseEvent("click", {bubbles: true}));
  });
  await waitFor(() => {
    assert.equal(requests.filter((url) => url.endsWith(`/${bundle.id}`)).length, 1);
  });
  assert.equal(within(article).getByRole("button", {name: "查看分析报告"}).getAttribute("aria-busy"), "true");
  detail.resolve(Response.json({
    ok: true,
    bundle: snapshot.bundles[0],
    task: snapshot.tasks[0],
    artifacts: snapshot.artifacts.filter((artifact) => artifact.taskId === snapshot.tasks[0].id),
    markdown: "# 报告",
    previewable: true,
  }));
  await screen.findByRole("region", {name: `${bundle.title}报告预览`});

  const downloadButton = within(article).getByRole("button", {name: "下载成果包"});
  act(() => {
    downloadButton.dispatchEvent(new dom.window.MouseEvent("click", {bubbles: true}));
    downloadButton.dispatchEvent(new dom.window.MouseEvent("click", {bubbles: true}));
  });
  await waitFor(() => {
    assert.equal(requests.filter((url) => url.endsWith("/download")).length, 1);
  });
  const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
  download.resolve(new Response(bytes, {headers: {
    "content-disposition": 'attachment; filename="bundle.zip"',
    "content-length": String(bytes.byteLength),
    "content-type": "application/zip",
  }}));
  await waitFor(() => assert.equal(clickedDownloadAnchors.length, 1));

  const revealButton = within(article).getByRole("button", {name: "在访达中显示"});
  act(() => {
    revealButton.dispatchEvent(new dom.window.MouseEvent("click", {bubbles: true}));
    revealButton.dispatchEvent(new dom.window.MouseEvent("click", {bubbles: true}));
  });
  await waitFor(() => {
    assert.equal(requests.filter((url) => url.endsWith("/reveal")).length, 1);
  });
  reveal.resolve(Response.json({ok: true, bundleId: bundle.id}));
  await waitFor(() => assert.match(screen.getByRole("status", {name: "成果包操作状态"}).textContent ?? "", /已在访达/u));

  const detailButton = within(article).getByRole("button", {name: "展开明细"});
  await userEvent.setup({document}).click(detailButton);
  assert.equal(within(article).getByRole("button", {name: "展开明细"}).getAttribute("aria-expanded"), "true");
  assert.match(screen.getByRole("status", {name: "成果包界面状态"}).textContent ?? "", /明细已展开/u);
});

test("竞品成果包安全收敛超过 2 MiB 的不可预览响应和三类动作错误", async () => {
  const snapshot = competitorWorkspaceSnapshot();
  const messages: string[] = [];
  globalThis.fetch = withCompetitorHealth(async (input) => {
    const url = String(input);
    if (url.endsWith("/download") || url.endsWith("/reveal")) {
      return Response.json({ok: false, error: "INTERNAL_ERROR", debug: "bridge-secret"}, {status: 500});
    }
    return Response.json({
      ok: true,
      bundle: snapshot.bundles[0],
      task: snapshot.tasks[0],
      artifacts: snapshot.artifacts.filter((artifact) => artifact.taskId === snapshot.tasks[0].id),
      markdown: null,
      previewable: false,
    });
  });
  const {bundle} = renderCompetitorBundleFixture({}, (message) => messages.push(message));
  const article = screen.getByRole("article", {name: `${bundle.title} 成果包`});

  await userEvent.setup({document}).click(within(article).getByRole("button", {name: "查看分析报告"}));
  assert.ok(await screen.findByRole("region", {name: `${bundle.title}报告预览`}));
  assert.match(screen.getByRole("status", {name: "成果包操作状态"}).textContent ?? "", /暂时无法预览/u);
  await userEvent.setup({document}).click(within(article).getByRole("button", {name: "下载成果包"}));
  await waitFor(() => assert.match(messages.at(-1) ?? "", /下载失败/u));
  await userEvent.setup({document}).click(within(article).getByRole("button", {name: "在访达中显示"}));
  await waitFor(() => assert.match(messages.at(-1) ?? "", /无法在访达/u));
  assert.doesNotMatch(`${document.body.innerHTML}${messages.join(" ")}`, /bridge-secret/u);
});

test("竞品成果包卸载时取消三类动作并忽略所有迟到副作用", async () => {
  const snapshot = competitorWorkspaceSnapshot();
  const pending = new Map<string, ReturnType<typeof deferredValue<Response>>>();
  const signals = new Map<string, AbortSignal | null>();
  const messages: string[] = [];
  globalThis.fetch = withCompetitorHealth((input, init) => {
    const url = String(input);
    const kind = url.endsWith("/download") ? "download" : url.endsWith("/reveal") ? "reveal" : "detail";
    const deferred = deferredValue<Response>();
    pending.set(kind, deferred);
    signals.set(kind, init?.signal ?? null);
    return deferred.promise;
  });
  const {bundle, view} = renderCompetitorBundleFixture({}, (message) => messages.push(message));
  const article = screen.getByRole("article", {name: `${bundle.title} 成果包`});
  act(() => {
    for (const name of ["查看分析报告", "下载成果包", "在访达中显示"]) {
      within(article).getByRole("button", {name}).dispatchEvent(
        new dom.window.MouseEvent("click", {bubbles: true}),
      );
    }
  });
  await waitFor(() => {
    assert.deepEqual([...pending.keys()].sort(), ["detail", "download", "reveal"]);
  });
  view.unmount();
  for (const signal of signals.values()) assertSignalAborted(signal);

  const raw = snapshot.bundles[0];
  const rawTask = snapshot.tasks[0];
  const rawArtifacts = snapshot.artifacts.filter((artifact) => artifact.taskId === rawTask.id);
  const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
  await act(async () => {
    pending.get("detail")?.resolve(Response.json({ok: true, bundle: raw, task: rawTask, artifacts: rawArtifacts, markdown: "# 迟到", previewable: true}));
    pending.get("download")?.resolve(new Response(bytes, {headers: {"content-length": "4", "content-type": "application/zip"}}));
    pending.get("reveal")?.resolve(Response.json({ok: true, bundleId: bundle.id}));
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  assert.deepEqual(messages, []);
  assert.equal(clickedDownloadAnchors.length, 0);
  assert.equal(createdMarkdownBlobs.length, 0);
});

test("竞品成果包下载在 URL 或 anchor 异常时仍释放资源并解锁", async () => {
  const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
  globalThis.fetch = withCompetitorHealth(async () => new Response(bytes, {headers: {
    "content-length": String(bytes.byteLength),
    "content-type": "application/zip",
  }}));
  const {bundle} = renderCompetitorBundleFixture();
  const article = screen.getByRole("article", {name: `${bundle.title} 成果包`});
  const originalCreateObjectUrl = URL.createObjectURL;
  try {
    Object.defineProperty(URL, "createObjectURL", {configurable: true, value: () => { throw new Error("create failed"); }});
    await userEvent.setup({document}).click(within(article).getByRole("button", {name: "下载成果包"}));
    await waitFor(() => assert.equal((within(article).getByRole("button", {name: "下载成果包"}) as HTMLButtonElement).disabled, false));
  } finally {
    Object.defineProperty(URL, "createObjectURL", {configurable: true, value: originalCreateObjectUrl});
  }

  const originalClick = dom.window.HTMLAnchorElement.prototype.click;
  try {
    dom.window.HTMLAnchorElement.prototype.click = function clickWithFailure() {
      clickedDownloadAnchors.push(this);
      throw new Error("click failed");
    };
    await userEvent.setup({document}).click(within(article).getByRole("button", {name: "下载成果包"}));
    await waitFor(() => assert.equal(revokedMarkdownUrls.length, 1));
    assert.equal(clickedDownloadAnchors.at(-1)?.isConnected, false);
    assert.equal((within(article).getByRole("button", {name: "下载成果包"}) as HTMLButtonElement).disabled, false);
  } finally {
    dom.window.HTMLAnchorElement.prototype.click = originalClick;
  }
});

test("竞品成果包区分总空、分类空和聚焦不可用", async () => {
  const user = userEvent.setup({document});
  const empty = render(
    <CompetitorResultBundles artifacts={[]} bundles={[]} onPreview={() => undefined} />,
  );
  assert.ok(screen.getByText("暂无竞品成果包"));
  empty.unmount();

  const fixture = competitorBundleUiFixture();
  const filtered = render(
    <CompetitorResultBundles artifacts={[fixture.artifact]} bundles={[fixture.bundle]} onPreview={() => undefined} />,
  );
  await user.click(screen.getByRole("button", {name: "抖音作品"}));
  assert.ok(screen.getByText("当前分类暂无成果包"));
  filtered.unmount();

  render(
    <CompetitorResultBundles
      artifacts={[fixture.artifact]}
      bundles={[fixture.bundle]}
      initialTaskId="competitor-20260801-missing-focus"
      onPreview={() => undefined}
    />,
  );
  assert.ok(screen.getByText("本次成果暂不可用，请查看全部成果或稍后刷新"));
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
  assertSignalAborted(requestSignal);
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
  assertSignalAborted(requestSignal);
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

test("navigating away restores the exact text-model entry baseline after edit, add, delete, default, and test", async () => {
  const originalModels = [
    {
      id: "nav-alpha",
      provider: "OpenAI",
      displayName: "Nav Alpha",
      modelId: "alpha-1",
      baseUrl: "https://api.openai.com/v1",
      enabled: true,
      isDefault: true,
      connectionStatus: "connected",
      testedFingerprint:
        "[\"https://api.openai.com/v1\",\"alpha-1\",\"revision-nav-alpha\"]",
    },
    {
      id: "nav-beta",
      provider: "OpenAI",
      displayName: "Nav Beta",
      modelId: "beta-1",
      baseUrl: "https://api.openai.com/v1",
      enabled: true,
      isDefault: false,
      connectionStatus: "connected",
      testedFingerprint:
        "[\"https://api.openai.com/v1\",\"beta-1\",\"revision-nav-beta\"]",
    },
  ];
  const originalCredentials = {
    "nav-alpha": "sk-nav-alpha-original",
    "nav-beta": "sk-nav-beta-original",
  };
  const originalRevisions = {
    "nav-alpha": "revision-nav-alpha",
    "nav-beta": "revision-nav-beta",
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
  globalThis.fetch = (async () => Response.json({ ok: true })) as typeof fetch;
  const user = userEvent.setup({ document });
  render(<Home />);

  await user.click(screen.getByRole("button", { name: "模型配置" }));
  await user.click(screen.getByRole("button", { name: "删除 Nav Alpha" }));
  const betaCard = screen
    .getByRole("heading", { name: "Nav Beta" })
    .closest("article");
  assert.ok(betaCard);
  const beta = within(betaCard);
  await user.click(beta.getByRole("radio", { name: "设为默认" }));
  await user.type(
    beta.getByLabelText("文案模型 API Key"),
    "sk-nav-beta-replacement",
  );
  await user.clear(beta.getByLabelText("文案模型名称"));
  await user.type(beta.getByLabelText("文案模型名称"), "beta-edited");
  await user.click(beta.getByRole("button", { name: "测试文案模型" }));
  await waitFor(() => {
    assert.equal(
      beta.getByRole("status", { name: "Nav Beta 连接状态" }).textContent,
      "连接成功",
    );
  });

  await user.click(screen.getByRole("button", { name: "添加文案模型" }));
  const newModelCard = screen
    .getByRole("heading", { name: "新增文案模型" })
    .closest("article");
  assert.ok(newModelCard);
  const newModel = within(newModelCard);
  await user.type(newModel.getByLabelText("服务商"), "Partner");
  await user.type(newModel.getByLabelText("模型显示名称"), "Nav Gamma");
  await user.type(newModel.getByLabelText("文案模型 API Key"), "sk-nav-gamma");
  await user.type(
    newModel.getByLabelText("文案接口地址"),
    "https://models.partner-example.com/v1",
  );
  await user.type(newModel.getByLabelText("文案模型名称"), "gamma-1");
  await user.click(newModel.getByRole("button", { name: "添加模型" }));
  assert.ok(screen.getByRole("heading", { name: "Nav Gamma" }));

  await user.click(screen.getByRole("button", { name: "AI 对话" }));
  await user.click(screen.getByRole("button", { name: "模型配置" }));

  await waitFor(() => {
    assert.ok(screen.getByRole("heading", { name: "Nav Alpha" }));
    assert.ok(screen.getByRole("heading", { name: "Nav Beta" }));
    assert.equal(screen.queryByRole("heading", { name: "Nav Gamma" }), null);
    assert.deepEqual(
      JSON.parse(
        window.localStorage.getItem("ai-workbench:model-registry:v2") ?? "null",
      ),
      originalModels,
    );
    assert.deepEqual(
      JSON.parse(
        window.localStorage.getItem("ai-workbench:model-credentials:v1") ?? "null",
      ),
      originalCredentials,
    );
    assert.deepEqual(
      JSON.parse(
        window.localStorage.getItem(
          "ai-workbench:model-credential-revisions:v1",
        ) ?? "null",
      ),
      originalRevisions,
    );
  });
});

test("navigating away restores the exact image-model entry baseline after edit and test", async () => {
  const originalImageConfig = {
    baseUrl: "https://api.openai.com/v1",
    modelId: "image-original",
    enabled: true,
    connectionStatus: "connected",
    testedFingerprint:
      "[\"https://api.openai.com/v1\",\"image-original\",\"revision-image-nav\"]",
  };
  window.localStorage.setItem(
    "ai-workbench:image-model-config:v1",
    JSON.stringify(originalImageConfig),
  );
  window.localStorage.setItem(
    "ai-workbench:image-model-credential:v1",
    "sk-image-nav-original",
  );
  window.localStorage.setItem(
    "ai-workbench:image-model-credential-revision:v1",
    "revision-image-nav",
  );
  globalThis.fetch = (async () => Response.json({ ok: true })) as typeof fetch;
  const user = userEvent.setup({ document });
  render(<Home />);

  await user.click(screen.getByRole("button", { name: "模型配置" }));
  await user.type(
    screen.getByLabelText("生图模型 API Key"),
    "sk-image-nav-replacement",
  );
  await user.clear(screen.getByLabelText("生图模型名称"));
  await user.type(screen.getByLabelText("生图模型名称"), "image-edited");
  await user.click(screen.getByRole("button", { name: "测试生图模型" }));
  await waitFor(() => {
    assert.equal(
      screen.getByRole("status", { name: "生图模型连接状态" }).textContent,
      "连接成功",
    );
  });
  await user.click(screen.getByRole("button", { name: "AI 对话" }));
  await user.click(screen.getByRole("button", { name: "模型配置" }));

  await waitFor(() => {
    assert.equal(
      (screen.getByLabelText("生图模型名称") as HTMLInputElement).value,
      "image-original",
    );
    assert.equal(
      screen.getByRole("status", { name: "生图模型连接状态" }).textContent,
      "连接成功",
    );
    assert.deepEqual(
      JSON.parse(
        window.localStorage.getItem("ai-workbench:image-model-config:v1") ?? "null",
      ),
      originalImageConfig,
    );
    assert.equal(
      window.localStorage.getItem("ai-workbench:image-model-credential:v1"),
      "sk-image-nav-original",
    );
    assert.equal(
      window.localStorage.getItem(
        "ai-workbench:image-model-credential-revision:v1",
      ),
      "revision-image-nav",
    );
  });
});

test("a successful Save commits the new text and image baseline across later navigation", async () => {
  const user = userEvent.setup({ document });
  render(<Home />);

  await user.click(screen.getByRole("button", { name: "模型配置" }));
  await user.type(
    screen.getByLabelText("文案模型 API Key"),
    "sk-save-baseline-text",
  );
  await user.type(
    screen.getByLabelText("文案接口地址"),
    "https://api.openai.com/v1",
  );
  await user.clear(screen.getByLabelText("文案模型名称"));
  await user.type(screen.getByLabelText("文案模型名称"), "saved-text-model");
  await user.type(
    screen.getByLabelText("生图模型 API Key"),
    "sk-save-baseline-image",
  );
  await user.type(
    screen.getByLabelText("生图接口地址"),
    "https://api.openai.com/v1",
  );
  await user.type(
    screen.getByLabelText("生图模型名称"),
    "saved-image-model",
  );
  await user.click(screen.getByRole("button", { name: "保存设置" }));
  await user.click(screen.getByRole("button", { name: "AI 对话" }));
  await user.click(screen.getByRole("button", { name: "模型配置" }));

  await waitFor(() => {
    assert.equal(
      (screen.getByLabelText("文案模型名称") as HTMLInputElement).value,
      "saved-text-model",
    );
    assert.equal(
      (screen.getByLabelText("生图模型名称") as HTMLInputElement).value,
      "saved-image-model",
    );
    assert.match(
      window.localStorage.getItem("ai-workbench:model-credentials:v1") ?? "",
      /sk-save-baseline-text/,
    );
    assert.equal(
      window.localStorage.getItem("ai-workbench:image-model-credential:v1"),
      "sk-save-baseline-image",
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
  assertSignalAborted(requestSignal);
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
  assertSignalAborted(requestSignal);
  await user.click(screen.getByRole("button", { name: "模型配置" }));
  await waitFor(() => {
    assert.equal(
      screen.getByRole("status", { name: "GPT-5.6 连接状态" }).textContent,
      "未测试",
    );
    assert.equal(
      (screen.getByLabelText("文案接口地址") as HTMLInputElement).value,
      "",
    );
    assert.doesNotMatch(
      window.localStorage.getItem("ai-workbench:model-registry:v2") ?? "",
      /"connectionStatus":"testing"/,
    );
  });
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

test("leaving during an image probe aborts it and returning shows the restored non-testing baseline", async () => {
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
    screen.getByLabelText("生图模型 API Key"),
    "sk-active-image-leave",
  );
  await user.type(
    screen.getByLabelText("生图接口地址"),
    "https://api.openai.com/v1",
  );
  await user.type(
    screen.getByLabelText("生图模型名称"),
    "image-active-leave",
  );
  await user.click(screen.getByRole("button", { name: "测试生图模型" }));
  await waitFor(() => assert.ok(requestSignal));
  await user.click(screen.getByRole("button", { name: "AI 对话" }));
  pending.resolve(Response.json({ ok: true }));

  assertSignalAborted(requestSignal);
  await user.click(screen.getByRole("button", { name: "模型配置" }));
  await waitFor(() => {
    assert.equal(
      screen.getByRole("status", { name: "生图模型连接状态" }).textContent,
      "未测试",
    );
    assert.equal(
      (screen.getByLabelText("生图接口地址") as HTMLInputElement).value,
      "",
    );
    assert.equal(
      (screen.getByLabelText("生图模型名称") as HTMLInputElement).value,
      "",
    );
    assert.doesNotMatch(
      window.localStorage.getItem("ai-workbench:image-model-config:v1") ?? "",
      /"connectionStatus":"testing"/,
    );
    assert.doesNotMatch(
      window.localStorage.getItem("ai-workbench:image-model-credential:v1") ?? "",
      /sk-active-image-leave/,
    );
  });
});

test("leaving an unedited image probe restores the exact configured entry baseline", async () => {
  const originalImageConfig = {
    baseUrl: "https://api.openai.com/v1",
    modelId: "image-no-edit-leave",
    enabled: true,
    connectionStatus: "connected",
    testedFingerprint:
      "[\"https://api.openai.com/v1\",\"image-no-edit-leave\",\"revision-image-no-edit\"]",
  };
  window.localStorage.setItem(
    "ai-workbench:image-model-config:v1",
    JSON.stringify(originalImageConfig),
  );
  window.localStorage.setItem(
    "ai-workbench:image-model-credential:v1",
    "sk-fake-image-no-edit",
  );
  window.localStorage.setItem(
    "ai-workbench:image-model-credential-revision:v1",
    "revision-image-no-edit",
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
  await user.click(screen.getByRole("button", { name: "AI 对话" }));

  assertSignalAborted(requestSignal);
  assert.deepEqual(
    JSON.parse(
      window.localStorage.getItem("ai-workbench:image-model-config:v1") ?? "null",
    ),
    originalImageConfig,
  );
  assert.equal(
    window.localStorage.getItem("ai-workbench:image-model-credential:v1"),
    "sk-fake-image-no-edit",
  );
  assert.equal(
    window.localStorage.getItem(
      "ai-workbench:image-model-credential-revision:v1",
    ),
    "revision-image-no-edit",
  );

  pending.resolve(Response.json({ ok: true }));
  await user.click(screen.getByRole("button", { name: "模型配置" }));
  await waitFor(() => {
    assert.equal(
      screen.getByRole("status", { name: "生图模型连接状态" }).textContent,
      "连接成功",
    );
    assert.equal(
      (screen.getByLabelText("生图模型名称") as HTMLInputElement).value,
      "image-no-edit-leave",
    );
    assert.deepEqual(
      JSON.parse(
        window.localStorage.getItem("ai-workbench:image-model-config:v1") ?? "null",
      ),
      originalImageConfig,
    );
  });
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
    (screen.getByLabelText("协议") as unknown as HTMLSelectElement).value,
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

test("聊天会话首次发送后进入独立区域，并在导航后保留当前会话", async () => {
  installConnectedChatModels([
    {
      id: "chat-session-navigation",
      provider: "OpenAI",
      displayName: "会话测试模型",
      modelId: "session-chat",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-session-navigation",
      revision: "revision-session-navigation",
    },
  ]);
  const pending = deferredValue<Response>();
  globalThis.fetch = (async () => pending.promise) as typeof fetch;
  const user = userEvent.setup({ document });
  render(<Home />);

  await user.type(screen.getByLabelText("聊天消息输入框"), "第一条测试问题");
  await user.click(screen.getByRole("button", { name: "发送" }));

  assert.ok(
    await screen.findByRole("region", { name: "聊天会话" }),
  );
  assert.ok(
    await screen.findByRole("heading", { name: "第一条测试问题" }),
  );
  assert.ok(
    within(screen.getByRole("navigation", { name: "聊天历史" }))
      .getByRole("button", { name: "打开会话：第一条测试问题" }),
  );
  assert.equal(
    screen.getByLabelText("当前模型").textContent?.replace(/\s+/g, ""),
    "当前模型会话测试模型",
  );
  await user.click(screen.getByRole("button", { name: "模型配置" }));
  await user.click(screen.getByRole("button", { name: "AI 对话" }));

  assert.ok(
    within(screen.getByRole("log", { name: "聊天记录" }))
      .getByText("第一条测试问题"),
  );
});

test("历史侧栏在首次发送后展示独立聊天区、截断标题并支持新建和切换", async () => {
  installConnectedChatModels([
    {
      id: "chat-workspace-history",
      provider: "OpenAI",
      displayName: "历史侧栏模型",
      modelId: "history-chat",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-chat-workspace-history",
      revision: "revision-chat-workspace-history",
    },
  ]);
  globalThis.fetch = (async () =>
    Response.json({ ok: true, reply: "历史侧栏回复" })) as typeof fetch;
  const user = userEvent.setup({ document });
  render(<Home />);

  const question = "123456789012345678901234567890";
  const truncatedTitle = "123456789012345678901234…";
  await user.type(screen.getByLabelText("聊天消息输入框"), question);
  await user.click(screen.getByRole("button", { name: "发送" }));

  await waitFor(() => assert.ok(screen.getByText("历史侧栏回复")));
  const workspace = screen.getByRole("region", { name: "聊天会话" });
  assert.ok(workspace.classList.contains("chat-workspace"));
  assert.ok(
    within(workspace).getByRole("heading", { name: truncatedTitle }),
  );
  const history = within(workspace).getByRole("navigation", {
    name: "聊天历史",
  });
  assert.ok(
    within(history).getByRole("button", {
      name: `打开会话：${truncatedTitle}`,
    }),
  );
  assert.ok(within(history).getByText("发起新对话"));

  const transcript = within(workspace).getByRole("log", { name: "聊天记录" });
  assert.ok(
    within(transcript).getByText(question).closest("article")
      ?.classList.contains("user"),
  );
  assert.ok(
    within(transcript).getByText("历史侧栏回复").closest("article")
      ?.classList.contains("assistant"),
  );
  assert.ok(within(transcript).getByText("历史侧栏模型"));

  await user.click(within(history).getByRole("button", { name: "新建会话" }));
  assert.ok(
    screen.getByRole("heading", {
      name: "今天想聊什么，或推进什么任务？",
    }),
  );
  await user.click(
    within(screen.getByRole("navigation", { name: "聊天历史" })).getByRole(
      "button",
      { name: `打开会话：${truncatedTitle}` },
    ),
  );
  assert.ok(screen.getByRole("heading", { name: truncatedTitle }));
  assert.ok(screen.getByText("历史侧栏回复"));
});

test("桌面端发起新对话后显式聚焦新会话输入框", async () => {
  installConnectedChatModels([
    {
      id: "chat-workspace-desktop-focus",
      provider: "OpenAI",
      displayName: "桌面聚焦模型",
      modelId: "desktop-focus-chat",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-chat-workspace-desktop-focus",
      revision: "revision-chat-workspace-desktop-focus",
    },
  ]);
  globalThis.fetch = (async () =>
    Response.json({ ok: true, reply: "桌面聚焦回复" })) as typeof fetch;
  const user = userEvent.setup({ document });
  render(<Home />);

  await user.type(screen.getByLabelText("聊天消息输入框"), "桌面聚焦会话");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => assert.ok(screen.getByText("桌面聚焦回复")));

  await user.click(screen.getByRole("button", { name: "新建会话" }));

  const input = screen.getByLabelText("聊天消息输入框");
  assert.equal(document.activeElement === input, true);
});

test("删除会话必须确认并按非当前、当前和最后会话规则选择", async () => {
  installConnectedChatModels([
    {
      id: "chat-workspace-delete",
      provider: "OpenAI",
      displayName: "删除规则模型",
      modelId: "delete-chat",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-chat-workspace-delete",
      revision: "revision-chat-workspace-delete",
    },
  ]);
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      turns: Array<{ role: string; content: string }>;
    };
    return Response.json({
      ok: true,
      reply: `回复：${body.turns.at(-1)?.content}`,
    });
  }) as typeof fetch;
  const user = userEvent.setup({ document });
  render(<Home />);

  for (const title of ["会话甲", "会话乙", "会话丙"]) {
    await user.type(screen.getByLabelText("聊天消息输入框"), title);
    await user.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => assert.ok(screen.getByText(`回复：${title}`)));
    if (title !== "会话丙") {
      await user.click(screen.getByRole("button", { name: "新建会话" }));
    }
  }

  await user.click(
    screen.getByRole("button", { name: "删除会话：会话甲" }),
  );
  const canceledDialog = screen.getByRole("alertdialog", {
    name: "确认删除会话：会话甲",
  });
  await user.click(within(canceledDialog).getByRole("button", { name: "取消" }));
  assert.ok(screen.getByRole("heading", { name: "会话丙" }));
  assert.ok(screen.getByRole("button", { name: "打开会话：会话甲" }));

  await user.click(
    screen.getByRole("button", { name: "删除会话：会话甲" }),
  );
  await user.click(
    within(
      screen.getByRole("alertdialog", { name: "确认删除会话：会话甲" }),
    ).getByRole("button", { name: "确认删除" }),
  );
  assert.equal(
    screen.queryByRole("button", { name: "打开会话：会话甲" }),
    null,
  );
  assert.ok(screen.getByRole("heading", { name: "会话丙" }));

  await user.click(
    screen.getByRole("button", { name: "删除会话：会话丙" }),
  );
  await user.click(
    within(
      screen.getByRole("alertdialog", { name: "确认删除会话：会话丙" }),
    ).getByRole("button", { name: "确认删除" }),
  );
  assert.ok(screen.getByRole("heading", { name: "会话乙" }));

  await user.click(
    screen.getByRole("button", { name: "删除会话：会话乙" }),
  );
  await user.click(
    within(
      screen.getByRole("alertdialog", { name: "确认删除会话：会话乙" }),
    ).getByRole("button", { name: "确认删除" }),
  );
  assert.equal(screen.queryByRole("region", { name: "聊天会话" }), null);
  assert.ok(
    screen.getByRole("heading", {
      name: "今天想聊什么，或推进什么任务？",
    }),
  );
});

test("删除确认支持键盘取消并在取消和确认后恢复合理焦点", async () => {
  installConnectedChatModels([
    {
      id: "chat-workspace-delete-focus",
      provider: "OpenAI",
      displayName: "删除焦点模型",
      modelId: "delete-focus-chat",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-chat-workspace-delete-focus",
      revision: "revision-chat-workspace-delete-focus",
    },
  ]);
  globalThis.fetch = (async () =>
    Response.json({ ok: true, reply: "删除焦点回复" })) as typeof fetch;
  const user = userEvent.setup({ document });
  render(<Home />);

  await user.type(screen.getByLabelText("聊天消息输入框"), "待删除焦点会话");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => assert.ok(screen.getByText("删除焦点回复")));

  const deleteTrigger = screen.getByRole("button", {
    name: "删除会话：待删除焦点会话",
  });
  await user.click(deleteTrigger);
  const firstDialog = screen.getByRole("alertdialog", {
    name: "确认删除会话：待删除焦点会话",
  });
  const cancel = within(firstDialog).getByRole("button", { name: "取消" });
  assert.equal(document.activeElement === cancel, true);

  await user.click(cancel);
  assert.equal(screen.queryByRole("alertdialog"), null);
  assert.equal(document.activeElement === deleteTrigger, true);

  await user.click(deleteTrigger);
  const escapeDialog = screen.getByRole("alertdialog", {
    name: "确认删除会话：待删除焦点会话",
  });
  assert.equal(
    document.activeElement
      === within(escapeDialog).getByRole("button", { name: "取消" }),
    true,
  );
  await user.keyboard("{Escape}");
  assert.equal(screen.queryByRole("alertdialog"), null);
  assert.equal(document.activeElement === deleteTrigger, true);

  await user.click(deleteTrigger);
  const secondDialog = screen.getByRole("alertdialog", {
    name: "确认删除会话：待删除焦点会话",
  });
  await user.click(
    within(secondDialog).getByRole("button", { name: "确认删除" }),
  );

  const welcomeInput = screen.getByLabelText("聊天消息输入框");
  assert.equal(document.activeElement === welcomeInput, true);
});

test("删除确认打开期间后台会话更新不会抢走当前确认按钮焦点", async () => {
  const session: ChatSessionHistoryItem = {
    id: "delete-rerender-focus",
    title: "后台更新焦点会话",
    displayTitle: "后台更新焦点会话",
    isDraft: false,
    messages: [
      {
        id: "delete-rerender-focus-message",
        role: "user",
        content: "后台更新焦点会话",
        status: "sent",
        createdAt: 100,
      },
    ],
    createdAt: 100,
    updatedAt: 100,
    draft: "",
    pendingRequest: null,
    scrollOffset: 0,
    scrollWasNearBottom: true,
    scrollMessageCount: 1,
  };
  const renderSidebar = (updatedAt: number) => (
    <ChatHistorySidebar
      activeSessionId={session.id}
      onClose={() => undefined}
      onCreate={() => undefined}
      onDelete={() => undefined}
      onSelect={() => undefined}
      open
      sessions={[{ ...session, updatedAt }]}
    />
  );
  const view = render(renderSidebar(100));
  fireEvent.click(
    screen.getByRole("button", { name: "删除会话：后台更新焦点会话" }),
  );

  const confirmation = screen.getByRole("alertdialog", {
    name: "确认删除会话：后台更新焦点会话",
  });
  const confirmButton = within(confirmation).getByRole("button", {
    name: "确认删除",
  });
  confirmButton.focus();
  assert.equal(document.activeElement === confirmButton, true);

  view.rerender(renderSidebar(101));

  assert.equal(document.activeElement === confirmButton, true);
});

test("键盘发送区分 Enter、Shift+Enter 和输入法组合并在发送后清空聚焦", async () => {
  installConnectedChatModels([
    {
      id: "chat-workspace-keyboard",
      provider: "OpenAI",
      displayName: "键盘模型",
      modelId: "keyboard-chat",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-chat-workspace-keyboard",
      revision: "revision-chat-workspace-keyboard",
    },
  ]);
  const pending = deferredValue<Response>();
  let requestCount = 0;
  globalThis.fetch = (async () => {
    requestCount += 1;
    return pending.promise;
  }) as typeof fetch;
  const user = userEvent.setup({ document });
  render(<Home />);

  const input = screen.getByLabelText("聊天消息输入框") as HTMLTextAreaElement;
  await user.type(input, "第一行");
  await user.keyboard("{Shift>}{Enter}{/Shift}");
  assert.equal(input.value, "第一行\n");
  assert.equal(requestCount, 0);
  await user.type(input, "第二行");

  const composingEnter = new dom.window.KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key: "Enter",
  });
  Object.defineProperty(composingEnter, "isComposing", { value: true });
  fireEvent(input, composingEnter);
  assert.equal(requestCount, 0);
  assert.equal(input.value, "第一行\n第二行");

  await user.keyboard("{Enter}");
  await waitFor(() => assert.equal(requestCount, 1));
  const currentInput = screen.getByLabelText(
    "聊天消息输入框",
  ) as HTMLTextAreaElement;
  assert.equal(currentInput.value, "");
  assert.equal(document.activeElement, currentInput);
  assert.match(
    screen.getByRole("log", { name: "聊天记录" }).textContent ?? "",
    /第一行\s+第二行/,
  );
});

test("自动滚动只在接近底部时跟随新消息", async () => {
  installConnectedChatModels([
    {
      id: "chat-workspace-scroll",
      provider: "OpenAI",
      displayName: "滚动模型",
      modelId: "scroll-chat",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-chat-workspace-scroll",
      revision: "revision-chat-workspace-scroll",
    },
  ]);
  const replies = [deferredValue<Response>(), deferredValue<Response>()];
  let requestCount = 0;
  globalThis.fetch = (async () => {
    const pending = replies[requestCount];
    requestCount += 1;
    return pending.promise;
  }) as typeof fetch;
  const user = userEvent.setup({ document });
  render(<Home />);

  await user.type(screen.getByLabelText("聊天消息输入框"), "第一条滚动消息");
  await user.click(screen.getByRole("button", { name: "发送" }));
  const transcript = screen.getByRole("log", {
    name: "聊天记录",
  }) as HTMLElement;
  let scrollHeight = 400;
  Object.defineProperties(transcript, {
    clientHeight: { configurable: true, get: () => 200 },
    scrollHeight: { configurable: true, get: () => scrollHeight },
  });
  transcript.scrollTop = 120;
  fireEvent.scroll(transcript);
  scrollHeight = 560;
  replies[0].resolve(Response.json({ ok: true, reply: "接近底部回复" }));
  await waitFor(() => assert.ok(screen.getByText("接近底部回复")));
  assert.equal(transcript.scrollTop, 560);

  await user.type(screen.getByLabelText("聊天消息输入框"), "第二条滚动消息");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => assert.equal(requestCount, 2));
  scrollHeight = 700;
  transcript.scrollTop = 100;
  fireEvent.scroll(transcript);
  scrollHeight = 900;
  replies[1].resolve(Response.json({ ok: true, reply: "阅读位置回复" }));
  await waitFor(() => assert.ok(screen.getByText("阅读位置回复")));
  assert.equal(transcript.scrollTop, 100);
});

test("自动滚动切换会话时分别恢复非零位置且不把近底部偏移追到底", async () => {
  installConnectedChatModels([
    {
      id: "chat-workspace-scroll-restore",
      provider: "OpenAI",
      displayName: "滚动恢复模型",
      modelId: "scroll-restore-chat",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-chat-workspace-scroll-restore",
      revision: "revision-chat-workspace-scroll-restore",
    },
  ]);
  let requestCount = 0;
  globalThis.fetch = (async () => {
    requestCount += 1;
    return Response.json({ ok: true, reply: `滚动恢复回复 ${requestCount}` });
  }) as typeof fetch;
  const user = userEvent.setup({ document });
  render(<Home />);

  await user.type(screen.getByLabelText("聊天消息输入框"), "滚动会话甲");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => assert.ok(screen.getByText("滚动恢复回复 1")));
  const transcriptA = screen.getByRole("log", {
    name: "聊天记录",
  }) as HTMLElement;
  Object.defineProperties(transcriptA, {
    clientHeight: { configurable: true, get: () => 200 },
    scrollHeight: { configurable: true, get: () => 420 },
  });
  transcriptA.scrollTop = 144;
  fireEvent.scroll(transcriptA);
  assert.equal(420 - 200 - transcriptA.scrollTop, 76);

  await user.click(screen.getByRole("button", { name: "新建会话" }));
  await user.type(screen.getByLabelText("聊天消息输入框"), "滚动会话乙第一问");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => assert.ok(screen.getByText("滚动恢复回复 2")));
  await user.type(screen.getByLabelText("聊天消息输入框"), "滚动会话乙第二问");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => assert.ok(screen.getByText("滚动恢复回复 3")));
  const transcriptB = screen.getByRole("log", {
    name: "聊天记录",
  }) as HTMLElement;
  Object.defineProperties(transcriptB, {
    clientHeight: {
      configurable: true,
      get: () =>
        transcriptB.textContent?.includes("滚动会话甲") ? 200 : 240,
    },
    scrollHeight: {
      configurable: true,
      get: () =>
        transcriptB.textContent?.includes("滚动会话甲") ? 420 : 900,
    },
  });
  transcriptB.scrollTop = 260;
  fireEvent.scroll(transcriptB);

  await user.click(
    screen.getByRole("button", { name: "打开会话：滚动会话甲" }),
  );
  assert.equal(
    (screen.getByRole("log", { name: "聊天记录" }) as HTMLElement).scrollTop,
    144,
  );

  await user.click(
    screen.getByRole("button", { name: "打开会话：滚动会话乙第一问" }),
  );
  assert.equal(
    (screen.getByRole("log", { name: "聊天记录" }) as HTMLElement).scrollTop,
    260,
  );
});

test("会话在后台收到回复后通过 Provider 恢复近底部跟随状态", async () => {
  const elementPrototype = dom.window.HTMLElement.prototype;
  const originalClientHeight = Object.getOwnPropertyDescriptor(
    elementPrototype,
    "clientHeight",
  );
  const originalScrollHeight = Object.getOwnPropertyDescriptor(
    elementPrototype,
    "scrollHeight",
  );
  Object.defineProperty(elementPrototype, "clientHeight", {
    configurable: true,
    get() {
      return this.getAttribute("role") === "log" ? 200 : 0;
    },
  });
  Object.defineProperty(elementPrototype, "scrollHeight", {
    configurable: true,
    get() {
      if (this.getAttribute("role") !== "log") return 0;
      return this.textContent?.includes("甲会话后台长回复") ? 900 : 500;
    },
  });

  try {
    installConnectedChatModels([
      {
        id: "chat-workspace-scroll-provider",
        provider: "OpenAI",
        displayName: "滚动 Provider 模型",
        modelId: "scroll-provider-chat",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-chat-workspace-scroll-provider",
        revision: "revision-chat-workspace-scroll-provider",
      },
    ]);
    const backgroundReply = deferredValue<Response>();
    let requestCount = 0;
    globalThis.fetch = (async () => {
      requestCount += 1;
      if (requestCount === 3) return backgroundReply.promise;
      return Response.json({
        ok: true,
        reply: requestCount === 1 ? "甲会话初始回复" : "乙会话初始回复",
      });
    }) as typeof fetch;
    const user = userEvent.setup({ document });
    render(<Home />);

    await user.type(screen.getByLabelText("聊天消息输入框"), "滚动会话甲");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => assert.ok(screen.getByText("甲会话初始回复")));
    await user.click(screen.getByRole("button", { name: "新建会话" }));
    await user.type(screen.getByLabelText("聊天消息输入框"), "滚动会话乙");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => assert.ok(screen.getByText("乙会话初始回复")));

    await user.click(
      screen.getByRole("button", { name: "打开会话：滚动会话甲" }),
    );
    await user.type(screen.getByLabelText("聊天消息输入框"), "甲会话后台问题");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => assert.equal(requestCount, 3));
    const transcriptA = screen.getByRole("log", {
      name: "聊天记录",
    }) as HTMLElement;
    transcriptA.scrollTop = 220;
    fireEvent.scroll(transcriptA);
    await user.click(
      screen.getByRole("button", { name: "打开会话：滚动会话乙" }),
    );

    backgroundReply.resolve(
      Response.json({ ok: true, reply: "甲会话后台长回复" }),
    );
    await waitFor(() =>
      assert.equal(screen.queryByLabelText("活动会话提示") === null, true),
    );
    await user.click(
      screen.getByRole("button", { name: "打开会话：滚动会话甲" }),
    );

    const returnedTranscript = screen.getByRole("log", {
      name: "聊天记录",
    }) as HTMLElement;
    assert.ok(within(returnedTranscript).getByText("甲会话后台长回复"));
    assert.equal(returnedTranscript.scrollTop, 900);
  } finally {
    if (originalClientHeight) {
      Object.defineProperty(
        elementPrototype,
        "clientHeight",
        originalClientHeight,
      );
    } else {
      delete (elementPrototype as { clientHeight?: number }).clientHeight;
    }
    if (originalScrollHeight) {
      Object.defineProperty(
        elementPrototype,
        "scrollHeight",
        originalScrollHeight,
      );
    } else {
      delete (elementPrototype as { scrollHeight?: number }).scrollHeight;
    }
  }
});

test("返回后台增长的会话时仅在离开时接近底部才跟随新回复", () => {
  const elementPrototype = dom.window.HTMLElement.prototype;
  const originalClientHeight = Object.getOwnPropertyDescriptor(
    elementPrototype,
    "clientHeight",
  );
  const originalScrollHeight = Object.getOwnPropertyDescriptor(
    elementPrototype,
    "scrollHeight",
  );
  Object.defineProperty(elementPrototype, "clientHeight", {
    configurable: true,
    get() {
      return this.getAttribute("role") === "log" ? 200 : 0;
    },
  });
  Object.defineProperty(elementPrototype, "scrollHeight", {
    configurable: true,
    get() {
      if (this.getAttribute("role") !== "log") return 0;
      if (this.textContent?.includes("第二次后台新增回复")) return 1100;
      if (this.textContent?.includes("后台新增回复")) return 900;
      return this.textContent?.includes("旁观会话") ? 600 : 500;
    },
  });

  try {
    const savedPositions = new Map<
      string,
      {
        scrollOffset: number;
        wasNearBottom: boolean | undefined;
        messageCount: number | undefined;
      }
    >();
    const sessionA = {
      id: "scroll-background-a",
      title: "后台增长会话",
      messages: [
        {
          id: "scroll-a-user",
          role: "user",
          content: "后台增长问题",
          status: "sent",
          createdAt: 100,
        },
        {
          id: "scroll-a-assistant",
          role: "assistant",
          content: "初始回复",
          modelName: "滚动模型",
          createdAt: 101,
        },
      ],
      createdAt: 100,
      updatedAt: 101,
      draft: "",
      pendingRequest: null,
      scrollOffset: 0,
      scrollWasNearBottom: true,
      scrollMessageCount: 2,
    } as ChatSession;
    const sessionB = {
      ...sessionA,
      id: "scroll-background-b",
      title: "旁观会话",
      messages: [
        {
          id: "scroll-b-user",
          role: "user",
          content: "旁观会话",
          status: "sent",
          createdAt: 200,
        },
      ],
      createdAt: 200,
      updatedAt: 200,
      scrollMessageCount: 1,
    } as ChatSession;
    const onScrollOffsetChange = (
      sessionId: string,
      scrollOffset: number,
      wasNearBottom?: boolean,
      messageCount?: number,
    ) => {
      savedPositions.set(sessionId, {
        scrollOffset,
        wasNearBottom,
        messageCount,
      });
    };
    const renderTranscript = (session: ChatSession) => (
      <ChatTranscript
        isGenerating={false}
        key={session.id}
        onRetry={() => undefined}
        onScrollOffsetChange={onScrollOffsetChange}
        retryDisabled={false}
        session={session}
      />
    );
    const view = render(renderTranscript(sessionA));
    const transcriptA = screen.getByRole("log", {
      name: "聊天记录",
    }) as HTMLElement;
    transcriptA.scrollTop = 220;
    fireEvent.scroll(transcriptA);

    view.rerender(renderTranscript(sessionB));
    const nearBottomPosition = savedPositions.get(sessionA.id);
    assert.ok(nearBottomPosition);
    assert.deepEqual(nearBottomPosition, {
      scrollOffset: 220,
      wasNearBottom: true,
      messageCount: 2,
    });

    const sessionAWithBackgroundReply = {
      ...sessionA,
      messages: [
        ...sessionA.messages,
        {
          id: "scroll-a-background-assistant",
          role: "assistant",
          content: "后台新增回复",
          modelName: "滚动模型",
          createdAt: 102,
        },
      ],
      scrollOffset: nearBottomPosition.scrollOffset,
      scrollWasNearBottom: nearBottomPosition.wasNearBottom,
      scrollMessageCount: nearBottomPosition.messageCount,
    } as ChatSession;
    view.rerender(renderTranscript(sessionAWithBackgroundReply));
    const returnedNearBottomTranscript = screen.getByRole("log", {
      name: "聊天记录",
    }) as HTMLElement;
    assert.equal(returnedNearBottomTranscript.scrollTop, 900);

    returnedNearBottomTranscript.scrollTop = 100;
    fireEvent.scroll(returnedNearBottomTranscript);
    view.rerender(renderTranscript(sessionB));
    const readingPosition = savedPositions.get(sessionA.id);
    assert.ok(readingPosition);
    assert.deepEqual(readingPosition, {
      scrollOffset: 100,
      wasNearBottom: false,
      messageCount: 3,
    });

    const sessionAWithSecondBackgroundReply = {
      ...sessionAWithBackgroundReply,
      messages: [
        ...sessionAWithBackgroundReply.messages,
        {
          id: "scroll-a-second-background-assistant",
          role: "assistant",
          content: "第二次后台新增回复",
          modelName: "滚动模型",
          createdAt: 103,
        },
      ],
      scrollOffset: readingPosition.scrollOffset,
      scrollWasNearBottom: readingPosition.wasNearBottom,
      scrollMessageCount: readingPosition.messageCount,
    } as ChatSession;
    view.rerender(renderTranscript(sessionAWithSecondBackgroundReply));
    assert.equal(
      (screen.getByRole("log", { name: "聊天记录" }) as HTMLElement).scrollTop,
      100,
    );
  } finally {
    if (originalClientHeight) {
      Object.defineProperty(
        elementPrototype,
        "clientHeight",
        originalClientHeight,
      );
    } else {
      delete (elementPrototype as { clientHeight?: number }).clientHeight;
    }
    if (originalScrollHeight) {
      Object.defineProperty(
        elementPrototype,
        "scrollHeight",
        originalScrollHeight,
      );
    } else {
      delete (elementPrototype as { scrollHeight?: number }).scrollHeight;
    }
  }
});

test("移动端历史通过抽屉按钮开关并保护底部安全区", async () => {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 390,
  });
  installConnectedChatModels([
    {
      id: "chat-workspace-mobile",
      provider: "OpenAI",
      displayName: "移动端模型",
      modelId: "mobile-chat",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-chat-workspace-mobile",
      revision: "revision-chat-workspace-mobile",
    },
  ]);
  globalThis.fetch = (async () =>
    Response.json({ ok: true, reply: "移动端回复" })) as typeof fetch;
  const user = userEvent.setup({ document });
  render(<Home />);

  await user.type(screen.getByLabelText("聊天消息输入框"), "移动端会话");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => assert.ok(screen.getByText("移动端回复")));

  const drawer = document.querySelector(".chat-history-drawer");
  assert.ok(drawer);
  assert.equal(drawer.classList.contains("open"), false);
  await user.click(screen.getByRole("button", { name: "打开聊天历史" }));
  assert.equal(drawer.classList.contains("open"), true);
  await user.click(screen.getByRole("button", { name: "关闭聊天历史" }));
  assert.equal(drawer.classList.contains("open"), false);

  const css = readFileSync(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  const mobileStyles = css.slice(css.indexOf("@media (max-width: 760px)"));
  assert.match(mobileStyles, /env\(safe-area-inset-bottom\)/);
});

test("移动端短动态视口不会被固定最小高度推出输入器", () => {
  const css = readFileSync(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  const mobileStyles = css.slice(css.indexOf("@media (max-width: 760px)"));
  const workspaceRule = mobileStyles.match(
    /\.chat-workspace\s*\{([^}]*)\}/,
  )?.[1];

  assert.ok(workspaceRule);
  assert.match(workspaceRule, /height:\s*calc\(100dvh - 164px\)/);
  assert.match(workspaceRule, /min-height:\s*0/);
  assert.doesNotMatch(workspaceRule, /min-height:\s*[1-9]\d*px/);
});

test("移动端从历史发起新对话后聚焦输入框而不是历史入口", async () => {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 390,
  });
  installConnectedChatModels([
    {
      id: "chat-workspace-mobile-new-focus",
      provider: "OpenAI",
      displayName: "移动新会话聚焦模型",
      modelId: "mobile-new-focus-chat",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-chat-workspace-mobile-new-focus",
      revision: "revision-chat-workspace-mobile-new-focus",
    },
  ]);
  globalThis.fetch = (async () =>
    Response.json({ ok: true, reply: "移动新会话聚焦回复" })) as typeof fetch;
  const user = userEvent.setup({ document });
  render(<Home />);

  await user.type(screen.getByLabelText("聊天消息输入框"), "移动新会话聚焦");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => assert.ok(screen.getByText("移动新会话聚焦回复")));
  await user.click(screen.getByRole("button", { name: "打开聊天历史" }));
  await user.click(screen.getByRole("button", { name: "新建会话" }));

  const input = screen.getByLabelText("聊天消息输入框");
  assert.equal(document.activeElement === input, true);
});

test("移动端历史关闭时退出无障碍和焦点顺序并在打开关闭间管理焦点", async () => {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 390,
  });
  installConnectedChatModels([
    {
      id: "chat-workspace-mobile-focus",
      provider: "OpenAI",
      displayName: "移动焦点模型",
      modelId: "mobile-focus-chat",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-chat-workspace-mobile-focus",
      revision: "revision-chat-workspace-mobile-focus",
    },
  ]);
  globalThis.fetch = (async () =>
    Response.json({ ok: true, reply: "移动焦点回复" })) as typeof fetch;
  const user = userEvent.setup({ document });
  render(<Home />);

  await user.type(screen.getByLabelText("聊天消息输入框"), "移动焦点会话");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => assert.ok(screen.getByText("移动焦点回复")));

  const drawer = document.querySelector<HTMLElement>(".chat-history-drawer");
  assert.ok(drawer);
  await waitFor(() => {
    assert.equal(drawer.getAttribute("aria-hidden"), "true");
    assert.equal(drawer.hasAttribute("inert"), true);
  });
  assert.equal(screen.queryByRole("navigation", { name: "聊天历史" }), null);
  assert.equal(
    screen.queryByRole("button", { name: "打开会话：移动焦点会话" }),
    null,
  );

  const opener = screen.getByRole("button", { name: "打开聊天历史" });
  opener.focus();
  await user.tab({ shift: true });
  assert.equal(drawer.contains(document.activeElement), false);

  await user.click(opener);
  const closeButton = await screen.findByRole("button", {
    name: "关闭聊天历史",
  });
  assert.equal(drawer.getAttribute("aria-hidden"), null);
  assert.equal(drawer.hasAttribute("inert"), false);
  assert.equal(document.activeElement, closeButton);

  await user.keyboard("{Escape}");
  await waitFor(() => {
    assert.equal(drawer.getAttribute("aria-hidden"), "true");
    assert.equal(document.activeElement, opener);
  });

  await user.click(opener);
  assert.equal(document.activeElement, closeButton);
  const backdrop = drawer.querySelector<HTMLButtonElement>(
    ".chat-history-backdrop",
  );
  assert.ok(backdrop);
  fireEvent.click(backdrop);
  await waitFor(() => {
    assert.equal(drawer.getAttribute("aria-hidden"), "true");
    assert.equal(document.activeElement, opener);
  });
});

test("移动端删除确认优先消费 Escape，再次 Escape 才关闭抽屉", async () => {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 390,
  });
  installConnectedChatModels([
    {
      id: "chat-workspace-mobile-delete-focus",
      provider: "OpenAI",
      displayName: "移动删除焦点模型",
      modelId: "mobile-delete-focus-chat",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-chat-workspace-mobile-delete-focus",
      revision: "revision-chat-workspace-mobile-delete-focus",
    },
  ]);
  globalThis.fetch = (async () =>
    Response.json({ ok: true, reply: "移动删除焦点回复" })) as typeof fetch;
  const user = userEvent.setup({ document });
  render(<Home />);

  await user.type(screen.getByLabelText("聊天消息输入框"), "移动待删除会话");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => assert.ok(screen.getByText("移动删除焦点回复")));
  const opener = screen.getByRole("button", { name: "打开聊天历史" });
  await user.click(opener);
  const drawer = screen.getByRole("dialog", { name: "聊天历史抽屉" });
  const deleteTrigger = screen.getByRole("button", {
    name: "删除会话：移动待删除会话",
  });
  await user.click(deleteTrigger);
  const confirmation = screen.getByRole("alertdialog", {
    name: "确认删除会话：移动待删除会话",
  });
  const cancel = within(confirmation).getByRole("button", { name: "取消" });
  assert.equal(document.activeElement === cancel, true);

  await user.keyboard("{Escape}");
  assert.equal(screen.queryByRole("alertdialog"), null);
  assert.equal(drawer.classList.contains("open"), true);
  assert.equal(document.activeElement === deleteTrigger, true);

  await user.keyboard("{Escape}");
  await waitFor(() => {
    assert.equal(drawer.getAttribute("aria-hidden"), "true");
    assert.equal(document.activeElement, opener);
  });
});

test("移动端确认删除非最后会话后把焦点留在抽屉内控制项", async () => {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 390,
  });
  const historyItems: ChatSessionHistoryItem[] = [
    {
      id: "mobile-delete-first",
      title: "移动删除甲",
      displayTitle: "移动删除甲",
      isDraft: false,
      messages: [
        {
          id: "mobile-delete-first-message",
          role: "user",
          content: "移动删除甲",
          status: "sent",
          createdAt: 100,
        },
      ],
      createdAt: 100,
      updatedAt: 100,
      draft: "",
      pendingRequest: null,
      scrollOffset: 0,
      scrollWasNearBottom: true,
      scrollMessageCount: 1,
    },
    {
      id: "mobile-delete-second",
      title: "移动删除乙",
      displayTitle: "移动删除乙",
      isDraft: false,
      messages: [
        {
          id: "mobile-delete-second-message",
          role: "user",
          content: "移动删除乙",
          status: "sent",
          createdAt: 200,
        },
      ],
      createdAt: 200,
      updatedAt: 200,
      draft: "",
      pendingRequest: null,
      scrollOffset: 0,
      scrollWasNearBottom: true,
      scrollMessageCount: 1,
    },
  ];
  function MobileDeleteFocusHarness() {
    const [sessions, setSessions] = useState(historyItems);
    return (
      <ChatHistorySidebar
        activeSessionId="mobile-delete-second"
        onClose={() => undefined}
        onCreate={() => undefined}
        onDelete={(sessionId) =>
          setSessions((current) =>
            current.filter((session) => session.id !== sessionId),
          )}
        onSelect={() => undefined}
        open
        sessions={sessions}
      />
    );
  }
  const user = userEvent.setup({ document });
  render(<MobileDeleteFocusHarness />);

  const drawer = await screen.findByRole("dialog", {
    name: "聊天历史抽屉",
  });
  await user.click(
    screen.getByRole("button", { name: "删除会话：移动删除甲" }),
  );
  await user.click(
    within(
      screen.getByRole("alertdialog", {
        name: "确认删除会话：移动删除甲",
      }),
    ).getByRole("button", { name: "确认删除" }),
  );

  const createButton = screen.getByRole("button", { name: "新建会话" });
  assert.equal(document.activeElement === createButton, true);
  assert.equal(drawer.contains(document.activeElement), true);
});

test("移动端历史打开后父级重渲染不会抢走抽屉内当前焦点", async () => {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 390,
  });
  const renderSidebar = () => (
    <ChatHistorySidebar
      activeSessionId={null}
      onClose={() => undefined}
      onCreate={() => undefined}
      onDelete={() => undefined}
      onSelect={() => undefined}
      open
      sessions={[]}
    />
  );
  const view = render(renderSidebar());

  const closeButton = await screen.findByRole("button", {
    name: "关闭聊天历史",
  });
  await waitFor(() => assert.equal(document.activeElement, closeButton));
  const createButton = screen.getByRole("button", { name: "新建会话" });
  createButton.focus();

  view.rerender(renderSidebar());

  assert.equal(document.activeElement, createButton);
});

test("移动端模态历史抽屉将正反向 Tab 焦点限制在抽屉内", async () => {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 390,
  });
  const user = userEvent.setup({ document });
  render(
    <>
      <button type="button">背景操作</button>
      <ChatHistorySidebar
        activeSessionId={null}
        onClose={() => undefined}
        onCreate={() => undefined}
        onDelete={() => undefined}
        onSelect={() => undefined}
        open
        sessions={[]}
      />
    </>,
  );

  const drawer = await screen.findByRole("dialog", {
    name: "聊天历史抽屉",
  });
  const closeButton = screen.getByRole("button", {
    name: "关闭聊天历史",
  });
  const createButton = screen.getByRole("button", { name: "新建会话" });

  closeButton.focus();
  await user.tab({ shift: true });
  const reverseTabTarget = document.activeElement;
  createButton.focus();
  await user.tab();
  const forwardTabTarget = document.activeElement;

  assert.deepEqual(
    [reverseTabTarget, forwardTabTarget],
    [createButton, closeButton],
  );
  assert.equal(drawer.contains(reverseTabTarget), true);
  assert.equal(drawer.contains(forwardTabTarget), true);
});

test("聊天会话未发送的新会话在导航后不会进入历史", async () => {
  installConnectedChatModels([
    {
      id: "chat-session-empty",
      provider: "OpenAI",
      displayName: "空会话测试模型",
      modelId: "empty-session-chat",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-session-empty",
      revision: "revision-session-empty",
    },
  ]);
  const pending = deferredValue<Response>();
  globalThis.fetch = (async () => pending.promise) as typeof fetch;
  const user = userEvent.setup({ document });
  render(<Home />);

  await user.type(screen.getByLabelText("聊天消息输入框"), "保留的历史会话");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await user.click(screen.getByRole("button", { name: "新建会话" }));
  await user.click(screen.getByRole("button", { name: "模型配置" }));
  await user.click(screen.getByRole("button", { name: "AI 对话" }));

  const history = screen.getByRole("navigation", { name: "聊天历史" });
  assert.ok(
    within(history).getByRole("button", {
      name: "打开会话：保留的历史会话",
    }),
  );
  assert.equal(
    within(history).queryByRole("button", { name: "打开会话：新对话" }),
    null,
  );
});

test("非空草稿会话在切换后作为草稿历史项重新打开并恢复输入", async () => {
  installConnectedChatModels([
    {
      id: "chat-session-draft-history",
      provider: "OpenAI",
      displayName: "草稿历史模型",
      modelId: "draft-history-chat",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-session-draft-history",
      revision: "revision-session-draft-history",
    },
  ]);
  globalThis.fetch = (async () =>
    Response.json({ ok: true, reply: "已发送会话回复" })) as typeof fetch;
  const user = userEvent.setup({ document });
  render(<Home />);

  await user.type(screen.getByLabelText("聊天消息输入框"), "已发送会话");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => assert.ok(screen.getByText("已发送会话回复")));
  await user.click(screen.getByRole("button", { name: "新建会话" }));

  const draft = "这条草稿切换后必须完整恢复";
  await user.type(screen.getByLabelText("聊天消息输入框"), draft);
  const draftEntry = screen.getByRole("button", {
    name: `打开草稿：${draft}`,
  });
  assert.match(draftEntry.textContent ?? "", /草稿/);

  await user.click(
    screen.getByRole("button", { name: "打开会话：已发送会话" }),
  );
  assert.ok(screen.getByText("已发送会话回复"));
  await user.click(
    screen.getByRole("button", { name: `打开草稿：${draft}` }),
  );

  assert.equal(
    (screen.getByLabelText("聊天消息输入框") as HTMLTextAreaElement).value,
    draft,
  );
});

test("聊天会话状态只存在于当前 React 运行期", async () => {
  installConnectedChatModels([
    {
      id: "chat-session-runtime",
      provider: "OpenAI",
      displayName: "运行期测试模型",
      modelId: "runtime-session-chat",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-session-runtime",
      revision: "revision-session-runtime",
    },
  ]);
  const pending = deferredValue<Response>();
  globalThis.fetch = (async () => pending.promise) as typeof fetch;
  const user = userEvent.setup({ document });
  render(<Home />);

  await user.type(screen.getByLabelText("聊天消息输入框"), "仅当前运行期可见");
  await user.click(screen.getByRole("button", { name: "发送" }));
  assert.ok(
    await screen.findByRole("heading", { name: "仅当前运行期可见" }),
  );

  cleanup();
  render(<Home />);

  assert.equal(
    screen.queryByRole("navigation", { name: "聊天历史" }),
    null,
  );
  assert.equal(screen.queryByText("仅当前运行期可见"), null);
  await waitFor(() =>
    assert.ok(
      screen.getByRole("button", { name: "选择模型，当前 运行期测试模型" }),
    ),
  );
});

test("发送后聊天哨兵不会进入客户端存储、IndexedDB 或 console 调用", async () => {
  const sentinel = "__CHAT_PRIVACY_SENTINEL_019fad36__";
  installConnectedChatModels([
    {
      id: "chat-session-privacy-sentinel",
      provider: "OpenAI",
      displayName: "隐私回归模型",
      modelId: "privacy-sentinel-chat",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-session-privacy-regression",
      revision: "revision-session-privacy-regression",
    },
  ]);
  globalThis.fetch = (async () =>
    Response.json({ ok: true, reply: "隐私回归回复" })) as typeof fetch;
  const indexedDbAccesses: string[] = [];
  const availableIndexedDb = window.indexedDB;
  const canSnapshotIndexedDb =
    Boolean(availableIndexedDb)
    && typeof availableIndexedDb.databases === "function";
  const originalIndexedDbDescriptor = Object.getOwnPropertyDescriptor(
    window,
    "indexedDB",
  );
  if (!canSnapshotIndexedDb) {
    Object.defineProperty(window, "indexedDB", {
      configurable: true,
      get() {
        indexedDbAccesses.push("indexedDB");
        return undefined;
      },
    });
  }
  const consoleCalls: unknown[][] = [];
  const consoleMethods = ["debug", "error", "info", "log", "warn"] as const;
  const originalConsoleDescriptors = new Map<
    (typeof consoleMethods)[number],
    PropertyDescriptor | undefined
  >();
  for (const method of consoleMethods) {
    originalConsoleDescriptors.set(
      method,
      Object.getOwnPropertyDescriptor(console, method),
    );
    Object.defineProperty(console, method, {
      configurable: true,
      writable: true,
      value: (...args: unknown[]) => {
        consoleCalls.push(args);
      },
    });
  }

  let serializedIndexedDb = "";
  try {
    const user = userEvent.setup({ document });
    render(<Home />);
    await user.type(screen.getByLabelText("聊天消息输入框"), sentinel);
    await user.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => assert.ok(screen.getByText("隐私回归回复")));
    if (canSnapshotIndexedDb && availableIndexedDb) {
      serializedIndexedDb = await snapshotIndexedDb(availableIndexedDb);
    }
  } finally {
    for (const method of consoleMethods) {
      const descriptor = originalConsoleDescriptors.get(method);
      if (descriptor) Object.defineProperty(console, method, descriptor);
    }
    if (!canSnapshotIndexedDb) {
      if (originalIndexedDbDescriptor) {
        Object.defineProperty(window, "indexedDB", originalIndexedDbDescriptor);
      } else {
        delete (window as { indexedDB?: IDBFactory }).indexedDB;
      }
    }
  }

  const snapshotStorage = (storage: Storage) =>
    JSON.stringify(
      Array.from({ length: storage.length }, (_, index) => {
        const key = storage.key(index);
        return [key, key ? storage.getItem(key) : null];
      }),
    );
  const serializedConsoleCalls = consoleCalls
    .map((args) =>
      args.map((argument) => {
        try {
          return JSON.stringify(argument);
        } catch {
          return String(argument);
        }
      }))
    .join("\n");

  assert.doesNotMatch(snapshotStorage(window.localStorage), new RegExp(sentinel));
  assert.doesNotMatch(snapshotStorage(window.sessionStorage), new RegExp(sentinel));
  assert.deepEqual(indexedDbAccesses, []);
  assert.doesNotMatch(serializedIndexedDb, new RegExp(sentinel));
  assert.doesNotMatch(serializedConsoleCalls, new RegExp(sentinel));
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
  const transcript = screen.getByRole("log", { name: "聊天记录" });
  assert.equal(transcript.getAttribute("aria-live"), "polite");
  assert.equal(transcript.getAttribute("aria-relevant"), "additions text");
  assert.ok(within(transcript).getByText("规划本月内容"));
  assert.equal(
    (screen.getByLabelText("聊天消息输入框") as HTMLTextAreaElement).value,
    "",
  );
  assert.equal(
    (screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled,
    true,
  );
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
  assert.equal(
    screen.getByLabelText("当前模型").textContent?.replace(/\s+/g, ""),
    "当前模型Beta模型",
  );
  const transcript = screen.getByRole("log", { name: "聊天记录" });
  assert.ok(within(transcript).getByText("第一问"));
  assert.ok(within(transcript).getByText("Alpha 回复"));
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

test("同一会话连续对话三轮只携带本会话的完整问答", async () => {
  installConnectedChatModels([
    {
      id: "chat-continuous",
      provider: "OpenAI",
      displayName: "连续对话模型",
      modelId: "continuous-chat",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-chat-continuous",
      revision: "revision-chat-continuous",
    },
  ]);
  const requestBodies: Array<{
    turns: Array<{ role: string; content: string }>;
  }> = [];
  globalThis.fetch = (async (_input, init) => {
    requestBodies.push(JSON.parse(String(init?.body)));
    return Response.json({
      ok: true,
      reply: ["第一答", "第二答", "第三答"][requestBodies.length - 1],
    });
  }) as typeof fetch;
  const user = userEvent.setup({ document });
  render(<Home />);

  for (const [question, answer] of [
    ["第一问", "第一答"],
    ["第二问", "第二答"],
    ["第三问", "第三答"],
  ]) {
    await user.type(screen.getByLabelText("聊天消息输入框"), question);
    await user.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => assert.ok(screen.getByText(answer)));
  }

  assert.deepEqual(requestBodies[2].turns, [
    { role: "user", content: "第一问" },
    { role: "assistant", content: "第一答" },
    { role: "user", content: "第二问" },
    { role: "assistant", content: "第二答" },
    { role: "user", content: "第三问" },
  ]);
});

test("新会话第一次请求与旧会话隔离", async () => {
  installConnectedChatModels([
    {
      id: "chat-isolated",
      provider: "OpenAI",
      displayName: "会话隔离模型",
      modelId: "isolated-chat",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-chat-isolated",
      revision: "revision-chat-isolated",
    },
  ]);
  const requestBodies: Array<{
    turns: Array<{ role: string; content: string }>;
  }> = [];
  globalThis.fetch = (async (_input, init) => {
    requestBodies.push(JSON.parse(String(init?.body)));
    return Response.json({
      ok: true,
      reply: requestBodies.length === 1 ? "旧会话回答" : "新会话回答",
    });
  }) as typeof fetch;
  const user = userEvent.setup({ document });
  render(<Home />);

  await user.type(screen.getByLabelText("聊天消息输入框"), "旧会话问题");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => assert.ok(screen.getByText("旧会话回答")));
  await user.click(screen.getByRole("button", { name: "新建会话" }));
  await user.type(screen.getByLabelText("聊天消息输入框"), "新会话第一问");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => assert.ok(screen.getByText("新会话回答")));

  assert.deepEqual(requestBodies[1].turns, [
    { role: "user", content: "新会话第一问" },
  ]);
});

test("会话隔离下其他会话可编辑草稿但全局请求期间不能发送并显示活动会话提示", async () => {
  installConnectedChatModels([
    {
      id: "chat-global-request",
      provider: "OpenAI",
      displayName: "全局请求模型",
      modelId: "global-request-chat",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-chat-global-request",
      revision: "revision-chat-global-request",
    },
  ]);
  const pending = deferredValue<Response>();
  let requestCount = 0;
  globalThis.fetch = (async () => {
    requestCount += 1;
    return pending.promise;
  }) as typeof fetch;
  const user = userEvent.setup({ document });
  render(<Home />);

  await user.type(screen.getByLabelText("聊天消息输入框"), "活动会话问题");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => assert.equal(requestCount, 1));
  await user.click(screen.getByRole("button", { name: "新建会话" }));
  const input = screen.getByLabelText("聊天消息输入框");
  await user.type(input, "另一个会话的草稿");

  assert.equal((input as HTMLTextAreaElement).value, "另一个会话的草稿");
  assert.equal(
    (screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled,
    true,
  );
  assert.match(
    screen.getByRole("status", { name: "活动会话提示" }).textContent ?? "",
    /活动会话问题.*正在回复.*可继续编辑草稿/,
  );
  assert.equal(requestCount, 1);
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

test("停止后用户消息标记为已停止并可立即发送新问题", async () => {
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
  let requestCount = 0;
  globalThis.fetch = (async (_input, init) => {
    requestCount += 1;
    requestSignal = init?.signal as AbortSignal;
    if (requestCount === 1) return pending.promise;
    return Response.json({ ok: true, reply: "停止后的新回复" });
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

  assertSignalAborted(requestSignal);
  assert.ok(
    within(screen.getByRole("log", { name: "聊天记录" }))
      .getByText("保留这条消息"),
  );
  assert.ok(screen.getByText("已停止"));
  assert.equal(screen.queryByRole("button", { name: "停止" }), null);
  await user.type(screen.getByLabelText("聊天消息输入框"), "停止后的新问题");
  assert.equal(
    (screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled,
    false,
  );
  await user.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => assert.ok(screen.getByText("停止后的新回复")));
  pending.resolve(Response.json({ ok: true, reply: "不应出现的旧回复" }));
  await waitFor(() =>
    assert.equal(screen.queryByText("不应出现的旧回复"), null),
  );
});

test("失败后可重试且切换模型也不重复插入用户消息", async () => {
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

  assert.equal(
    within(screen.getByRole("log", { name: "聊天记录" }))
      .getAllByText("只保留一次").length,
    1,
  );
  assert.ok(screen.getByText("发送失败"));
  assert.doesNotMatch(document.body.textContent ?? "", new RegExp(firstKey));
  assert.doesNotMatch(document.body.textContent ?? "", new RegExp(rawProviderBody));
  await user.click(screen.getByRole("button", { name: "选择模型，当前 失败模型" }));
  await user.click(screen.getByRole("button", { name: /重试模型/ }));
  await user.click(screen.getByRole("button", { name: "重新发送" }));

  await waitFor(() => assert.ok(screen.getByText("安全重试成功")));
  assert.equal(
    within(screen.getByRole("log", { name: "聊天记录" }))
      .getAllByText("只保留一次").length,
    1,
  );
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

test("重试中的请求停止后标记为已停止且允许发送新问题", async () => {
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
    return Response.json({ ok: true, reply: "停止重试后的新回复" });
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
  assert.equal(screen.queryByRole("button", { name: "重新发送" }), null);
  assert.ok(screen.getByRole("button", { name: "停止" }));
  await user.click(screen.getByRole("button", { name: "停止" }));

  assert.equal(requestSignals[1]?.aborted, true);
  assert.ok(screen.getByText("已停止"));
  assert.equal(screen.queryByRole("button", { name: "重新发送" }), null);
  await user.type(screen.getByLabelText("聊天消息输入框"), "停止重试后的新问题");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => assert.ok(screen.getByText("停止重试后的新回复")));

  assert.equal(requestCount, 3);
  assert.equal(
    within(screen.getByRole("log", { name: "聊天记录" }))
      .getAllByText("需要恢复的消息").length,
    1,
  );
  assert.deepEqual(turns, [
    [{ role: "user", content: "需要恢复的消息" }],
    [{ role: "user", content: "需要恢复的消息" }],
    [{ role: "user", content: "停止重试后的新问题" }],
  ]);
  assert.equal(screen.queryByRole("button", { name: "重新发送" }), null);
});

test("失败后可直接发送新问题且不会被旧失败锁死", async () => {
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
    return requestCount === 1
      ? Response.json({ ok: false }, { status: 502 })
      : Response.json({ ok: true, reply: "失败后的新回复" });
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

  await user.type(screen.getByLabelText("聊天消息输入框"), "失败后的新问题");
  const send = screen.getByRole("button", { name: "发送" });
  assert.equal((send as HTMLButtonElement).disabled, false);
  await user.click(send);
  await waitFor(() => assert.ok(screen.getByText("失败后的新回复")));
  assert.equal(requestCount, 2);
  const transcript = screen.getByRole("log", { name: "聊天记录" });
  assert.equal(within(transcript).getAllByText("首次失败").length, 1);
  assert.equal(within(transcript).getAllByText("失败后的新问题").length, 1);
});

test("切换工作台页面不会丢会话且迟到响应更新原会话", async () => {
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

  assertSignalNotAborted(requestSignal);
  pending.resolve(Response.json({ ok: true, reply: "切换页面后的回复" }));
  await user.click(screen.getByRole("button", { name: "AI 对话" }));
  await waitFor(() => assert.ok(screen.getByText("切换页面后的回复")));
  assert.ok(
    within(screen.getByRole("log", { name: "聊天记录" }))
      .getByText("卸载前请求"),
  );
});

test("删除请求中的会话会中止请求且迟到响应不会进入其他会话", async () => {
  installConnectedChatModels([
    {
      id: "chat-delete-active",
      provider: "OpenAI",
      displayName: "删除会话模型",
      modelId: "delete-active-chat",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-chat-delete-active",
      revision: "revision-chat-delete-active",
    },
  ]);
  const pending = deferredValue<Response>();
  let requestCount = 0;
  let requestSignal: AbortSignal | null = null;
  globalThis.fetch = (async (_input, init) => {
    requestCount += 1;
    if (requestCount === 1) {
      requestSignal = init?.signal as AbortSignal;
      return pending.promise;
    }
    return Response.json({ ok: true, reply: "其他会话回复" });
  }) as typeof fetch;
  const user = userEvent.setup({ document });
  render(<Home />);

  await user.type(screen.getByLabelText("聊天消息输入框"), "请求中的会话");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => assert.ok(requestSignal));
  await user.click(screen.getByRole("button", { name: "新建会话" }));
  await user.type(screen.getByLabelText("聊天消息输入框"), "其他会话问题");
  await user.click(
    screen.getByRole("button", { name: "删除会话：请求中的会话" }),
  );
  await user.click(
    within(
      screen.getByRole("alertdialog", {
        name: "确认删除会话：请求中的会话",
      }),
    ).getByRole("button", { name: "确认删除" }),
  );

  await waitFor(() => assertSignalAborted(requestSignal));
  assert.equal(
    (screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled,
    false,
  );
  await user.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => assert.ok(screen.getByText("其他会话回复")));
  pending.resolve(Response.json({ ok: true, reply: "删除后的迟到响应" }));
  await waitFor(() =>
    assert.equal(screen.queryByText("删除后的迟到响应"), null),
  );
  assert.equal(screen.queryByText("请求中的会话"), null);
});

test("凭据修订变化会停止活动请求且聊天 DOM 不出现密钥", async () => {
  const oldKey = "sk-chat-revision-old-secret";
  const newKey = "sk-chat-revision-new-secret";
  installConnectedChatModels([
    {
      id: "chat-revision-change",
      provider: "OpenAI",
      displayName: "凭据修订模型",
      modelId: "revision-change-chat",
      baseUrl: "https://api.openai.com/v1",
      apiKey: oldKey,
      revision: "revision-chat-before-change",
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

  await user.type(screen.getByLabelText("聊天消息输入框"), "凭据变化中的问题");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => assert.ok(requestSignal));
  await user.click(screen.getByRole("button", { name: "模型配置" }));
  await user.type(screen.getByLabelText("文案模型 API Key"), newKey);
  await user.click(screen.getByRole("button", { name: "保存设置" }));
  await waitFor(() => assertSignalAborted(requestSignal));
  await user.click(screen.getByRole("button", { name: "AI 对话" }));

  assert.ok(screen.getByText("已停止"));
  assert.doesNotMatch(document.body.textContent ?? "", new RegExp(oldKey));
  assert.doesNotMatch(document.body.textContent ?? "", new RegExp(newKey));
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

test("competitor insight Agent opens its platform-aware collection console", async () => {
  const user = userEvent.setup({ document });
  render(<Home />);

  await user.click(screen.getByRole("button", { name: /竞品洞察 Agent/ }));
  assert.ok(screen.getByRole("heading", { name: "跨平台竞品洞察工作流" }));
  assert.match(
    screen.getByText("douyin-scraper").closest("article")?.textContent ?? "",
    /已接入/,
  );
  assert.match(
    screen.getByText("xiaohongshu-scraper").closest("article")?.textContent ?? "",
    /已接入/,
  );
  await user.click(screen.getByRole("button", { name: "开始竞品分析" }));

  assert.equal(
    screen.getByRole("button", { name: "Agent 对话" }).getAttribute("aria-current"),
    "page",
  );
  assert.ok(screen.getByRole("heading", { name: "粘贴链接，自动抓取、分析并封装" }));
  assert.ok(screen.getByText("抖音单视频会自动下载音频并在本机转写，转写文稿随分析报告一起进入成果包。"));
  assert.equal(screen.queryByRole("heading", { name: "企业矩阵基建诊断表" }), null);
  assert.equal(screen.queryByRole("button", { name: "开始矩阵诊断" }), null);
  await user.type(
    screen.getByLabelText("竞品主页或作品链接"),
    "https://v.douyin.com/test-account/",
  );
  assert.match(
    screen.getByRole("status", { name: "竞品平台识别状态" }).textContent ?? "",
    /已识别抖音/,
  );
  await user.clear(screen.getByLabelText("竞品主页或作品链接"));
  await user.type(
    screen.getByLabelText("竞品主页或作品链接"),
    "https://www.xiaohongshu.com/explore/test-note",
  );
  assert.match(
    screen.getByRole("status", {name: "竞品平台识别状态"}).textContent ?? "",
    /已识别小红书/,
  );
});

test("竞品抓取显示真实五阶段进度并先确认本地服务健康", async () => {
  const scrapePending = deferredValue<Response>();
  const requestedUrls: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url.endsWith("/health")) return competitorHealthResponse(url);
    const recordResponse = competitorRecordTestResponse(url, init);
    if (recordResponse) return recordResponse;
    if (url === "http://127.0.0.1:8766/scrape") {
      return scrapePending.promise;
    }
    if (url.endsWith("/analyze-artifacts")) {
      return Response.json(contentEvidenceReadyFixture());
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  const user = userEvent.setup({ document });
  render(<Home />);

  await user.click(screen.getByRole("button", { name: /竞品洞察 Agent/ }));
  await user.click(screen.getByRole("button", { name: "开始竞品分析" }));
  await user.type(
    screen.getByLabelText("竞品主页或作品链接"),
    "https://www.xiaohongshu.com/explore/test-note",
  );

  assert.ok(screen.getByRole("listitem", { name: "识别平台（已完成）" }));
  await user.click(screen.getByRole("button", { name: "抓取并分析" }));

  await waitFor(() => {
    assert.deepEqual(requestedUrls.filter((url) => url.includes(":8766/")), [
      "http://127.0.0.1:8766/health",
      "http://127.0.0.1:8766/scrape",
    ]);
  });
  assert.equal(
    requestedUrls.find((url) => !url.endsWith("/health")),
    "http://127.0.0.1:8768/project-tasks",
  );
  assert.match(
    screen.getByRole("status", { name: "竞品分析进度" }).textContent ?? "",
    /第 2\/5 步.*本地抓取 Skill/,
  );
  assert.ok(screen.getByRole("listitem", { name: "调用抓取 Skill（进行中）" }));

  scrapePending.resolve(new Response(JSON.stringify(scrapeReadyFixture("xiaohongshu", "content")), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
  await waitFor(() => {
    assert.match(
      screen.getByRole("status", { name: "竞品分析进度" }).textContent ?? "",
      /第 4\/5 步.*证据包已生成，等待配置模型/,
    );
  });
  assert.ok(screen.getByRole("listitem", { name: "生成洞察报告（进行中）" }));
});

test("竞品抓取把浏览器无法访问本机服务与抓取失败分开提示", async () => {
  const requestedUrls: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url === "http://127.0.0.1:8768/health") {
      return competitorHealthResponse(url);
    }
    const recordResponse = competitorRecordTestResponse(url, init);
    if (recordResponse) return recordResponse;
    throw new TypeError("Failed to fetch");
  }) as typeof fetch;
  const user = userEvent.setup({ document });
  render(<Home />);

  await user.click(screen.getByRole("button", { name: /竞品洞察 Agent/ }));
  await user.click(screen.getByRole("button", { name: "开始竞品分析" }));
  await user.type(
    screen.getByLabelText("竞品主页或作品链接"),
    "https://www.xiaohongshu.com/explore/test-note",
  );
  await user.click(screen.getByRole("button", { name: "抓取并分析" }));

  await waitFor(() => {
    assert.match(
      screen.getByRole("alert").textContent ?? "",
      /本地抓取服务未就绪/,
    );
  });
  assert.deepEqual(
    requestedUrls.filter((url) => url.includes(":8766/")),
    ["http://127.0.0.1:8766/health"],
  );
  assert.match(
    screen.getByRole("status", { name: "竞品分析进度" }).textContent ?? "",
    /第 2\/5 步.*本地抓取服务未就绪/,
  );
});

const persistedCompetitorTask = (
  status: "waiting" | "running" | "completed" | "failed" | "stopped" = "waiting",
  progress = status === "completed" ? 100 : 10,
  classification: {
    inputKind?: "unknown" | "account" | "content";
    category?: "douyin-account" | "douyin-content" | "xhs-account" | "xhs-note" | null;
    bundleId?: string | null;
  } = {},
  taskId = "competitor-20260801-ui-a1",
): ProjectTask => {
  const platformId = classification.category?.startsWith("douyin")
    ? "douyin"
    : "xiaohongshu";
  return ({
  id: taskId,
  agentId: "competitor-insight",
  title: "小红书作品抓取",
  platformId,
  platformLabel: platformId === "douyin" ? "抖音" : "小红书",
  skillId: platformId === "douyin" ? "douyin-scraper" : "xiaohongshu-scraper",
  sourceUrl: platformId === "douyin"
    ? "https://www.douyin.com/user/MS4wLjABAAAA-test"
    : "https://www.xiaohongshu.com/explore/test-note",
  status,
  progress,
  currentStep: status === "completed"
    ? "成果已登记"
    : status === "stopped"
      ? "用户已停止报告生成"
      : "平台已识别，等待连接",
  model: "xiaohongshu-scraper",
  createdAt: "2026-08-01T01:00:00.000Z",
  updatedAt: "2026-08-01T01:01:00.000Z",
  completedAt: status === "completed" ? "2026-08-01T01:01:00.000Z" : null,
  stoppedAt: status === "stopped" ? "2026-08-01T01:01:00.000Z" : null,
  errorSummary: status === "failed" ? "抓取失败" : null,
  artifactIds: status === "completed" ? ["artifact-0000000000000001"] : [],
  inputKind: classification.inputKind ?? "unknown",
  category: classification.category ?? null,
  bundleId: classification.bundleId ?? null,
  });
};

function competitorHealthResponse(url: string): Response {
  if (url.includes(":8768/")) {
    return Response.json({
      ok: true,
      stage: "healthy",
      service: "competitor-insight-report",
    });
  }
  const platformId = url.includes(":8766/") ? "xiaohongshu" : "douyin";
  return Response.json({
    ok: true,
    status: "ready",
    service: platformId === "douyin" ? "douyin-scraper" : "xiaohongshu-scraper",
    outputDir: `/controlled/outputs/competitor-insight/${platformId}`,
  });
}

function withCompetitorHealth(
  handler: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Response | Promise<Response>,
): typeof fetch {
  return (async (input, init) => {
    const url = String(input);
    if (url.endsWith("/health")) return competitorHealthResponse(url);
    return handler(input, init);
  }) as typeof fetch;
}

function scrapeReadyFixture(
  platformId: "douyin" | "xiaohongshu",
  inputKind: "account" | "content",
  taskId = "competitor-20260801-ui-a1",
) {
  const outputDir = `/controlled/outputs/competitor-insight/${platformId}/${taskId}`;
  const dataPath = `${outputDir}/structured-data.json`;
  const excelPath = inputKind === "account" ? `${outputDir}/account.xlsx` : null;
  const markdownPath = inputKind === "content" ? `${outputDir}/content.md` : null;
  return {
    platformId,
    skillId: platformId === "douyin" ? "douyin-scraper" : "xiaohongshu-scraper",
    inputKind,
    category: platformId === "douyin"
      ? inputKind === "account" ? "douyin-account" : "douyin-content"
      : inputKind === "account" ? "xhs-account" : "xhs-note",
    outputDir,
    dataPath,
    excelPath,
    markdownPath,
    imageDirectory: null,
    explicitPaths: [dataPath, ...[excelPath, markdownPath].filter((path): path is string => Boolean(path))],
    subjectName: inputKind === "account" ? "测试账号" : "测试作者",
    itemCount: 1,
  } as const;
}

function readyBundleSnapshot(
  platformId: "douyin" | "xiaohongshu",
  inputKind: "account" | "content",
  outputDir: string,
  reportPath: string,
  taskId = "competitor-20260801-ui-a1",
) {
  const category = platformId === "douyin"
    ? inputKind === "account" ? "douyin-account" : "douyin-content"
    : inputKind === "account" ? "xhs-account" : "xhs-note";
  const bundleId = "bundle-0000000000000001";
  const artifact = {
    id: "artifact-0000000000000001",
    agentId: "competitor-insight",
    taskId,
    kind: "markdown",
    filename: reportPath.split("/").at(-1) ?? "report.md",
    absolutePath: reportPath,
    sizeBytes: 128,
    completedAt: "2026-08-01T01:02:00.000Z",
    previewable: true,
    exists: true,
    isDirectory: false,
    markdown: null,
  };
  const task = persistedCompetitorTask("completed", 100, {
    inputKind,
    category,
    bundleId,
  }, taskId);
  return {
    ok: true,
    tasks: [task],
    artifacts: [artifact],
    bundles: [{
      id: bundleId,
      agentId: "competitor-insight",
      taskId: task.id,
      platformId,
      inputKind,
      category,
      subjectName: inputKind === "account" ? "测试账号" : "测试作者",
      itemCount: 1,
      status: "ready",
      rootDirectory: outputDir,
      primaryReportPath: reportPath,
      manifestPath: `${outputDir}/${bundleId}.manifest.json`,
      archivePath: `${outputDir}/${bundleId}.zip`,
      artifactIds: [artifact.id],
      createdAt: "2026-08-01T01:01:00.000Z",
      updatedAt: "2026-08-01T01:02:00.000Z",
    }],
  };
}

function competitorWorkspaceSnapshot(
  currentBundleId = "bundle-00000000000000a1",
) {
  const currentTaskId = "competitor-20260801-ui-a1";
  const historyTaskId = "competitor-20260801-bundle-history";
  const currentRoot = `/controlled/outputs/competitor-insight/xiaohongshu/${currentTaskId}`;
  const historyRoot = `/controlled/outputs/competitor-insight/douyin/${historyTaskId}`;
  const tasks = [
    {
      ...persistedCompetitorTask("completed", 100, {
        inputKind: "content",
        category: "xhs-note",
        bundleId: currentBundleId,
      }),
      id: currentTaskId,
      title: "小红书笔记分析成果包",
      sourceUrl: "https://www.xiaohongshu.com/explore/test-note?token=query-secret&source=private",
      artifactIds: [
        "artifact-00000000000000a1",
        "artifact-00000000000000a2",
        "artifact-00000000000000a3",
      ],
    },
    {
      ...persistedCompetitorTask("completed", 100, {
        inputKind: "account",
        category: "douyin-account",
        bundleId: "bundle-00000000000000b1",
      }),
      id: historyTaskId,
      title: "历史抖音账号成果包",
      platformId: "douyin",
      platformLabel: "抖音",
      skillId: "douyin-scraper",
      sourceUrl: "https://www.douyin.com/user/history?token=history-secret",
      model: "douyin-scraper",
      artifactIds: ["artifact-00000000000000b1"],
    },
  ];
  const artifacts = [
    {
      id: "artifact-00000000000000a1", agentId: "competitor-insight",
      taskId: currentTaskId, kind: "markdown", filename: "current-report.md",
      absolutePath: `${currentRoot}/current-report.md`, sizeBytes: 512,
      completedAt: "2026-08-01T02:02:00.000Z", previewable: true,
      exists: true, isDirectory: false, markdown: null,
    },
    {
      id: "artifact-00000000000000a2", agentId: "competitor-insight",
      taskId: currentTaskId, kind: "excel", filename: "原始数据.xlsx",
      absolutePath: `${currentRoot}/原始数据.xlsx`, sizeBytes: 2048,
      completedAt: "2026-08-01T02:02:00.000Z", previewable: false,
      exists: true, isDirectory: false, markdown: null,
    },
    {
      id: "artifact-00000000000000a3", agentId: "competitor-insight",
      taskId: currentTaskId, kind: "json", filename: "structured-data.json",
      absolutePath: `${currentRoot}/structured-data.json`, sizeBytes: 1024,
      completedAt: "2026-08-01T02:02:00.000Z", previewable: false,
      exists: true, isDirectory: false, markdown: null,
    },
    {
      id: "artifact-00000000000000b1", agentId: "competitor-insight",
      taskId: historyTaskId, kind: "markdown", filename: "history-report.md",
      absolutePath: `${historyRoot}/history-report.md`, sizeBytes: 256,
      completedAt: "2026-08-01T01:02:00.000Z", previewable: true,
      exists: true, isDirectory: false, markdown: null,
    },
  ];
  return {
    ok: true,
    tasks,
    artifacts,
    bundles: [
      {
        id: currentBundleId, agentId: "competitor-insight", taskId: currentTaskId,
        platformId: "xiaohongshu", inputKind: "content", category: "xhs-note",
        subjectName: "测试作者", itemCount: 1, status: "ready",
        rootDirectory: currentRoot, primaryReportPath: `${currentRoot}/current-report.md`,
        manifestPath: `${currentRoot}/${currentBundleId}.manifest.json`,
        archivePath: `${currentRoot}/${currentBundleId}.zip`,
        artifactIds: artifacts.slice(0, 3).map((artifact) => artifact.id),
        createdAt: "2026-08-01T02:01:00.000Z", updatedAt: "2026-08-01T02:02:00.000Z",
      },
      {
        id: "bundle-00000000000000b1", agentId: "competitor-insight", taskId: historyTaskId,
        platformId: "douyin", inputKind: "account", category: "douyin-account",
        subjectName: "历史账号", itemCount: 12, status: "ready",
        rootDirectory: historyRoot, primaryReportPath: `${historyRoot}/history-report.md`,
        manifestPath: `${historyRoot}/bundle-00000000000000b1.manifest.json`,
        archivePath: `${historyRoot}/bundle-00000000000000b1.zip`,
        artifactIds: ["artifact-00000000000000b1"],
        createdAt: "2026-08-01T01:01:00.000Z", updatedAt: "2026-08-01T01:02:00.000Z",
      },
    ],
  };
}

function installCompletedWorkspaceFlow(
  finalizedSnapshot: ReturnType<typeof competitorWorkspaceSnapshot>,
  refreshedSnapshot = finalizedSnapshot,
) {
  const scrape = scrapeReadyFixture("xiaohongshu", "content", finalizedSnapshot.tasks[0].id);
  const report = {
    ...reportReadyFixture(),
    filename: "current-report.md",
    reportPath: finalizedSnapshot.artifacts[0].absolutePath,
  };
  let recordLoads = 0;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (url.includes("/project-records") && (init?.method ?? "GET") === "GET") {
      recordLoads += 1;
      return Response.json(refreshedSnapshot);
    }
    const recordResponse = competitorRecordTestResponse(url, init);
    if (recordResponse) return recordResponse;
    if (url.endsWith("/health")) return competitorHealthResponse(url);
    if (url.endsWith("/scrape")) return Response.json(scrape);
    if (url.endsWith("/analyze-artifacts")) return Response.json(contentEvidenceReadyFixture());
    if (url === "/api/agents/competitor-insight") {
      return Response.json({ok: true, batch: competitorBatchFixture("content")});
    }
    if (url.endsWith("/validate-section")) {
      return Response.json({
        ok: true, stage: "section_validated", evidenceId: "fedcba9876543210",
        batchId: "content", batch: body.batch,
      });
    }
    if (url.endsWith("/assemble-report")) return Response.json(report);
    if (url.endsWith("/bundle")) return Response.json(finalizedSnapshot);
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  return {getRecordLoads: () => recordLoads};
}

function competitorRecordTestResponse(
  url: string,
  init?: RequestInit,
): Response | null {
  const method = init?.method ?? "GET";
  const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
  if (url.endsWith("/project-tasks") && method === "POST") {
    return Response.json({ok: true, task: persistedCompetitorTask()});
  }
  if (
    url.includes("/project-tasks/competitor-20260801-ui-a1")
    && method === "PATCH"
  ) {
    const status = (body.status ?? "running") as "running" | "completed" | "failed";
    const inputKind = body.inputKind === "account" || body.inputKind === "content"
      ? body.inputKind
      : "unknown";
    const category = typeof body.category === "string" ? body.category : null;
    return Response.json({
      ok: true,
      task: persistedCompetitorTask(status, Number(body.progress ?? 10), {
        inputKind,
        category: category as "douyin-account" | "douyin-content" | "xhs-account" | "xhs-note" | null,
      }),
    });
  }
  if (url.endsWith("/artifacts") && method === "POST") {
    return Response.json({
      ok: true,
      tasks: [persistedCompetitorTask("running", 90)],
      artifacts: [],
    });
  }
  return null;
}

test("抓取失败会更新持久任务且不会通知成果跳转", async () => {
  const patches: Record<string, unknown>[] = [];
  const completedTaskIds: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (url.endsWith("/project-tasks") && method === "POST") {
      return Response.json({ok: true, task: persistedCompetitorTask()});
    }
    if (url.includes("/project-tasks/competitor-20260801-ui-a1") && method === "PATCH") {
      patches.push(body);
      const nextStatus = body.status as "running" | "failed";
      return Response.json({ok: true, task: persistedCompetitorTask(nextStatus)});
    }
    if (url.endsWith("/health")) return competitorHealthResponse(url);
    if (url.endsWith("/scrape")) {
      return Response.json({ok: false, message: "平台采集失败"}, {status: 502});
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  const user = userEvent.setup({document});
  render(
    <ModelRegistryProvider>
      <CompetitorInsightPanel
        mode="run"
        onPreview={() => undefined}
        onTaskCompleted={(taskId) => completedTaskIds.push(taskId)}
      />
    </ModelRegistryProvider>,
  );

  await user.type(
    screen.getByLabelText("竞品主页或作品链接"),
    "https://www.xiaohongshu.com/explore/test-note",
  );
  await user.click(screen.getByRole("button", {name: "抓取并分析"}));

  await waitFor(() => assert.match(screen.getByRole("alert").textContent ?? "", /抓取任务未完成/));
  assert.deepEqual(completedTaskIds, []);
  assert.equal(patches.at(-1)?.status, "failed");
  assert.equal(patches.at(-1)?.errorSummary, "抓取任务未完成，请检查链接后重试。");
});

type CompetitorReportRequest = {
  url: string;
  init?: RequestInit;
  body: Record<string, unknown> | null;
};

function installCompetitorReportModel() {
  installConnectedChatModels([
    {
      id: "competitor-report-model",
      provider: "OpenAI",
      displayName: "竞品报告模型",
      modelId: "gpt-competitor-report",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-competitor-report-secret",
      revision: "revision-competitor-report",
    },
  ]);
  window.localStorage.setItem(
    "ai-workbench:agent-model-selections:v1",
    JSON.stringify({ "competitor-insight": "competitor-report-model" }),
  );
}

function competitorBatchFixture(
  batchId: "strategy" | "performance" | "execution" | "content",
) {
  const empty = {
    claims: [],
    topicDirections: [],
    filmingTemplates: [],
    conversionItems: [],
    executionDays: [],
  };
  if (batchId === "content") {
    return {
      batchId,
      claims: ["content-overview", "content-structure", "interaction", "conversion"].map((section) => ({
        section,
        statement: "仅基于当前公开作品的待验证判断",
        strength: "hypothesis",
        evidenceIds: ["XHS-E0001"],
        rationale: "公开证据有限",
        verificationPlan: "补充样本后人工复核",
        complianceNotes: ["不承诺疗效"],
      })),
      topicDirections: Array.from({ length: 3 }, (_, index) => ({
        title: `内容选题 ${index + 1}`,
        angle: "公开证据角度",
        evidenceIds: ["XHS-E0001"],
        complianceNotes: ["人工复核"],
        strength: "hypothesis",
        verificationPlan: "扩大样本验证",
      })),
      filmingTemplates: [{
        name: "内容拍法",
        hook: "公开数据开场",
        structure: ["证据", "判断", "边界"],
        evidenceIds: ["XHS-E0001"],
        complianceNotes: ["人工复核"],
        strength: "hypothesis",
        verificationPlan: "小流量测试",
      }],
      conversionItems: [],
      executionDays: [],
    };
  }
  if (batchId !== "execution") return { batchId, ...empty };
  return {
    batchId,
    claims: [],
    topicDirections: Array.from({ length: 5 }, (_, index) => ({
      title: `选题 ${index + 1}`,
      angle: "经营证据角度",
      evidenceIds: ["DY-E0001"],
      complianceNotes: ["不承诺疗效"],
    })),
    filmingTemplates: Array.from({ length: 3 }, (_, index) => ({
      name: `拍法 ${index + 1}`,
      hook: "公开数据开场",
      structure: ["证据", "判断", "边界"],
      evidenceIds: ["DY-E0001"],
      complianceNotes: ["人工复核"],
    })),
    conversionItems: [],
    executionDays: Array.from({ length: 7 }, (_, index) => ({
      day: index + 1,
      action: `执行动作 ${index + 1}`,
      evidenceIds: ["DY-E0001"],
      complianceNotes: ["不做医疗诊断"],
    })),
  };
}

function evidenceReadyFixture(
  outputDir = "/controlled/outputs/competitor-insight/douyin/competitor-20260801-ui-a1",
) {
  const evidence = [{
    evidenceId: "DY-E0001",
    title: "第一条作品",
    likes: 20,
    comments: 2,
    collects: 3,
    shares: 1,
    totalInteractions: 26,
    publishedAt: "2026-07-01T10:00:00",
  }];
  const ranking = { status: "available", evidenceIds: ["DY-E0001"] };
  return {
    ok: true,
    stage: "evidence_ready",
    evidenceId: "0123456789abcdef",
    platformId: "douyin",
    inputKind: "account",
    reportType: "douyin-account",
    outputDir,
    subjectName: "测试账号",
    itemCount: 1,
    account: {
      nickname: "测试账号",
      followers: 100,
      signature: "分享日常生活与健康管理常识",
    },
    completeness: {
      missingFields: ["粉丝数"],
      warnings: ["公开互动不等于成交"],
    },
    batchInputs: {
      strategy: {
        batchId: "strategy",
        allowedEvidenceIds: ["DY-E0001"],
        account: {
          nickname: "测试账号",
          followers: 100,
          signature: "分享日常生活与健康管理常识",
        },
        availability: { comments: true, collects: true, shares: true },
        rankings: { overall: ranking, startup: ranking },
        evidence,
      },
      performance: {
        batchId: "performance",
        allowedEvidenceIds: ["DY-E0001"],
        availability: { comments: true, collects: true, shares: true },
        metrics: {
          workCount: 1,
          averageLikes: 20,
          averageComments: 2,
          averageCollects: 3,
          averageShares: 1,
          averageInteractions: 26,
          maxInteractions: 26,
          aboveAverageInteractionCount: 0,
          top10InteractionShare: 1,
          maxToAverageMultiple: 1,
        },
        rankings: {
          overall: ranking,
          startup: ranking,
          collect: ranking,
          share: ranking,
          comment: ranking,
        },
        evidence,
      },
      execution: {
        batchId: "execution",
        allowedEvidenceIds: ["DY-E0001"],
        availability: { comments: true, collects: true, shares: true },
        rankings: {
          overall: ranking,
          collect: ranking,
          share: ranking,
          comment: ranking,
        },
        evidence,
      },
    },
  };
}

function contentEvidenceReadyFixture() {
  return {
    ok: true,
    stage: "evidence_ready",
    evidenceId: "fedcba9876543210",
    platformId: "xiaohongshu",
    inputKind: "content",
    reportType: "xhs-note",
    outputDir: "/controlled/outputs/competitor-insight/xiaohongshu/competitor-20260801-ui-a1",
    subjectName: "测试作者",
    itemCount: 1,
    account: { nickname: "测试作者" },
    completeness: { missingFields: [], warnings: ["单篇样本仅供趋势参考"] },
    batchInputs: {
      content: {
        batchId: "content",
        allowedEvidenceIds: ["XHS-E0001"],
        author: { nickname: "测试作者" },
        content: { title: "公开作品", body: "已抓取文本", transcript: "" },
        evidence: [{
          evidenceId: "XHS-E0001",
          title: "公开作品",
          likes: 1,
          comments: 1,
          collects: 1,
          shares: 1,
          totalInteractions: 4,
          publishedAt: "2026-07-01",
        }],
      },
    },
  };
}

function reportReadyFixture() {
  return {
    ok: true,
    stage: "report_ready",
    filename: "测试账号_抖音账号分析报告.md",
    reportPath:
      "/Users/test/outputs/competitor-insight/reports/测试账号_抖音账号分析报告.md",
    markdown: "# 抖音账号分析报告\n\n同一次组装响应的 Markdown。",
    validationErrors: [],
  };
}

const ACCOUNT_ANALYSIS_REQUEST: CompetitorAnalysisRequest = {
  requestId: 1,
  taskId: "competitor-20260801-ui-a1",
  platformId: "douyin",
  inputKind: "account",
  outputDir: "/controlled/outputs/competitor-insight/douyin/competitor-20260801-ui-a1",
  dataPath: "/controlled/outputs/competitor-insight/douyin/competitor-20260801-ui-a1/structured-data.json",
  excelPath: "/controlled/outputs/competitor-insight/douyin/competitor-20260801-ui-a1/account.xlsx",
};

function CompetitorAnalysisRequestHarness({
  onStopped,
}: {
  onStopped?: (message: string) => Promise<boolean>;
} = {}) {
  const [analysisRequest, setAnalysisRequest] =
    useState<CompetitorAnalysisRequest | null>(null);
  const [completedReportPath, setCompletedReportPath] = useState("");
  return (
    <>
      <button
        onClick={() => setAnalysisRequest(ACCOUNT_ANALYSIS_REQUEST)}
        type="button"
      >
        开始报告控制器测试
      </button>
      {completedReportPath ? <output aria-label="报告控制器完成">{completedReportPath}</output> : null}
      <CompetitorReportRunner
        analysisRequest={analysisRequest}
        onCompleted={(report) => setCompletedReportPath(report.reportPath)}
        onStopped={onStopped}
      />
    </>
  );
}

async function openCompetitorAnalysisRequestRunner(
  onStopped?: (message: string) => Promise<boolean>,
) {
  const user = userEvent.setup({document});
  render(
    <ModelRegistryProvider>
      <CompetitorAnalysisRequestHarness onStopped={onStopped} />
    </ModelRegistryProvider>,
  );
  await user.click(screen.getByRole("button", {name: "开始报告控制器测试"}));
  return user;
}

async function openCompetitorReportRunner() {
  const user = userEvent.setup({ document });
  render(<Home />);
  await user.click(screen.getByRole("button", { name: /竞品洞察 Agent/ }));
  await user.click(screen.getByRole("button", { name: "开始竞品分析" }));
  return user;
}

async function runAccountLinkWithoutModel() {
  const calls: CompetitorReportRequest[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({url, init, body});
    const recordResponse = competitorRecordTestResponse(url, init);
    if (recordResponse) return recordResponse;
    if (url.endsWith("/health")) return competitorHealthResponse(url);
    if (url.endsWith("/scrape")) {
      return Response.json(scrapeReadyFixture("douyin", "account"));
    }
    if (url.endsWith("/analyze-artifacts")) {
      return Response.json(evidenceReadyFixture());
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  const user = await openCompetitorReportRunner();
  await user.type(
    screen.getByLabelText("竞品主页或作品链接"),
    "https://www.douyin.com/user/MS4wLjABAAAA-test",
  );
  await user.click(screen.getByRole("button", {name: "抓取并分析"}));
  return calls;
}

test("竞品洞察只有链接入口且完整显示五阶段", async () => {
  await openCompetitorReportRunner();

  assert.equal(screen.queryByLabelText("选择已有 Excel 文件"), null);
  assert.equal(screen.queryByText("分析已有 Excel"), null);
  assert.ok(screen.getByRole("button", { name: "抓取并分析" }));
  const workflow = screen.getByRole("list", {name: "竞品洞察处理流程"});
  assert.equal(
    within(workflow).getAllByRole("listitem")
      .filter((item) => /[（(]/u.test(item.getAttribute("aria-label") ?? "")).length,
    5,
  );
  assert.deepEqual(
    within(workflow).getAllByRole("listitem").map((item) => item.textContent?.replace(/^\d/u, "")),
    ["识别平台", "调用抓取 Skill", "整理账号数据", "生成洞察报告", "整理成果包"],
  );
  assert.doesNotMatch(document.body.textContent ?? "", /第二入口|50 MB/u);

  const styles = readFileSync(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  assert.match(
    styles,
    /\.competitor-workflow\s*\{[^}]*grid-template-columns:\s*repeat\(5,\s*minmax\(0,\s*1fr\)\)/u,
  );
  assert.match(
    styles,
    /\.competitor-workflow li\s*\{[^}]*min-width:\s*0;[^}]*overflow-wrap:\s*anywhere;/u,
  );
  const narrowStyles = styles.slice(styles.indexOf("@media (max-width: 720px)"));
  assert.match(
    narrowStyles,
    /\.competitor-workflow,[^}]*\{\s*grid-template-columns:\s*1fr;/u,
  );
});

test("竞品洞察抓取并分析使用权威链接类型生成证据包", async () => {
  const requests: CompetitorReportRequest[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({ url, init, body });
    const recordResponse = competitorRecordTestResponse(url, init);
    if (recordResponse) return recordResponse;
    if (url.endsWith("/health")) {
      return competitorHealthResponse(url);
    }
    if (url.endsWith("/scrape")) {
      return Response.json(scrapeReadyFixture("douyin", "account"));
    }
    if (url.endsWith("/analyze-artifacts")) {
      return Response.json(evidenceReadyFixture());
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  const user = await openCompetitorReportRunner();

  await user.type(
    screen.getByLabelText("竞品主页或作品链接"),
    "https://v.douyin.com/test-account/",
  );
  await user.click(screen.getByRole("button", { name: "抓取并分析" }));

  await waitFor(() =>
    assert.ok(screen.getByRole("status", { name: "竞品报告生成状态" })),
  );
  assert.deepEqual(
    requests
      .map(({ url }) => url)
      .filter((url) => url.includes(":8765/") || url.endsWith("/analyze-artifacts")),
    [
      "http://127.0.0.1:8765/health",
      "http://127.0.0.1:8765/scrape",
      "http://127.0.0.1:8768/analyze-artifacts",
    ],
  );
  const analyzeRequest = requests.find(({url}) => url.endsWith("/analyze-artifacts"));
  assert.deepEqual(analyzeRequest?.body, {
    taskId: ACCOUNT_ANALYSIS_REQUEST.taskId,
    platformId: ACCOUNT_ANALYSIS_REQUEST.platformId,
    inputKind: ACCOUNT_ANALYSIS_REQUEST.inputKind,
    outputDir: ACCOUNT_ANALYSIS_REQUEST.outputDir,
    dataPath: ACCOUNT_ANALYSIS_REQUEST.dataPath,
    excelPath: ACCOUNT_ANALYSIS_REQUEST.excelPath,
  });
  assert.equal(analyzeRequest?.init?.credentials, "omit");
  assert.match(document.body.textContent ?? "", /证据包已生成/);
});

test("竞品洞察作品链接只生成 content 批次并在 ready 后回调", async () => {
  installCompetitorReportModel();
  const calls: CompetitorReportRequest[] = [];
  const completed: Array<[string, string]> = [];
  const scrape = scrapeReadyFixture("xiaohongshu", "content");
  const report = {
    ...reportReadyFixture(),
    filename: "content-report.md",
    reportPath: `${scrape.outputDir}/content-report.md`,
  };
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({url, init, body});
    const recordResponse = competitorRecordTestResponse(url, init);
    if (recordResponse) return recordResponse;
    if (url.endsWith("/health")) return competitorHealthResponse(url);
    if (url.endsWith("/scrape")) return Response.json(scrape);
    if (url.endsWith("/analyze-artifacts")) return Response.json(contentEvidenceReadyFixture());
    if (url === "/api/agents/competitor-insight") {
      assert.equal(body?.batchId, "content");
      return Response.json({ok: true, batch: competitorBatchFixture("content")});
    }
    if (url.endsWith("/validate-section")) {
      return Response.json({
        ok: true,
        stage: "section_validated",
        evidenceId: "fedcba9876543210",
        batchId: "content",
        batch: body?.batch,
      });
    }
    if (url.endsWith("/assemble-report")) return Response.json(report);
    if (url.endsWith("/bundle")) {
      return Response.json(readyBundleSnapshot("xiaohongshu", "content", scrape.outputDir, report.reportPath));
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  const user = userEvent.setup({document});
  render(
    <ModelRegistryProvider>
      <CompetitorInsightPanel
        mode="run"
        onPreview={() => undefined}
        onTaskCompleted={(taskId, bundleId) => completed.push([taskId, bundleId])}
      />
    </ModelRegistryProvider>,
  );

  await user.type(
    screen.getByLabelText("竞品主页或作品链接"),
    "https://www.xiaohongshu.com/explore/test-note",
  );
  await user.click(screen.getByRole("button", { name: "抓取并分析" }));

  await waitFor(() => assert.deepEqual(completed, [[
    "competitor-20260801-ui-a1",
    "bundle-0000000000000001",
  ]]));
  assert.equal(calls.filter((call) => call.url === "/api/agents/competitor-insight").length, 1);
  assert.deepEqual(
    calls
      .filter((call) => !call.url.includes(":8768/health"))
      .map((call) => `${call.init?.method ?? "GET"} ${new URL(call.url, "http://localhost").pathname}`),
    [
      "POST /project-tasks",
      "GET /health",
      "POST /scrape",
      "PATCH /project-tasks/competitor-20260801-ui-a1",
      "POST /analyze-artifacts",
      "POST /api/agents/competitor-insight",
      "POST /validate-section",
      "POST /assemble-report",
      "POST /project-tasks/competitor-20260801-ui-a1/artifacts",
      "POST /project-tasks/competitor-20260801-ui-a1/bundle",
    ],
  );
  const authoritative = calls.find((call) => call.init?.method === "PATCH");
  assert.equal(authoritative?.body?.inputKind, "content");
  assert.equal(authoritative?.body?.category, "xhs-note");
  assert.ok(screen.getByRole("listitem", {name: "整理成果包（已完成）"}));
});

test("竞品任务完成后只聚焦回调匹配的 ready 成果包并可查看全部", async () => {
  installCompetitorReportModel();
  const snapshot = competitorWorkspaceSnapshot();
  installCompletedWorkspaceFlow(snapshot);
  const user = userEvent.setup({document});
  render(<Home />);

  await user.click(screen.getByRole("button", {name: "Agent 项目"}));
  await user.click(screen.getByRole("button", {name: /竞品洞察 Agent/}));
  await user.click(screen.getByRole("button", {name: "开始竞品分析"}));
  await user.type(
    screen.getByLabelText("竞品主页或作品链接"),
    "https://www.xiaohongshu.com/explore/test-note",
  );
  await user.click(screen.getByRole("button", {name: "抓取并分析"}));

  assert.ok(await screen.findByRole("status", {name: "正在查看本次成果"}));
  assert.ok(screen.getByRole("heading", {name: "小红书笔记分析成果包"}));
  assert.equal(screen.queryByRole("heading", {name: "历史抖音账号成果包"}), null);
  await user.click(screen.getByRole("button", {name: "查看全部成果"}));
  assert.ok(screen.getByRole("heading", {name: "历史抖音账号成果包"}));
});

test("竞品完成回调 bundleId 与刷新快照不匹配时不会误切成果页", async () => {
  installCompetitorReportModel();
  const finalizedSnapshot = competitorWorkspaceSnapshot();
  const refreshedSnapshot = competitorWorkspaceSnapshot("bundle-00000000000000c1");
  const flow = installCompletedWorkspaceFlow(finalizedSnapshot, refreshedSnapshot);
  const user = userEvent.setup({document});
  render(<Home />);

  await user.click(screen.getByRole("button", {name: "Agent 项目"}));
  await user.click(screen.getByRole("button", {name: /竞品洞察 Agent/}));
  await user.click(screen.getByRole("button", {name: "开始竞品分析"}));
  await user.type(
    screen.getByLabelText("竞品主页或作品链接"),
    "https://www.xiaohongshu.com/explore/test-note",
  );
  await user.click(screen.getByRole("button", {name: "抓取并分析"}));

  await waitFor(() => assert.equal(flow.getRecordLoads(), 1));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    screen.getByRole("button", {name: "Agent 对话"}).getAttribute("aria-current"),
    "page",
  );
  assert.equal(screen.queryByRole("heading", {name: "成果包"}), null);
});

test("竞品完成回调对未完成、缺包、missing、legacy 和无主报告都不切成果页", async () => {
  const cases = ["未完成", "缺包", "missing", "legacy", "无主报告"] as const;
  for (const scenario of cases) {
    cleanup();
    document.body.innerHTML = "";
    window.localStorage.clear();
    installCompetitorReportModel();
    const finalized = competitorWorkspaceSnapshot();
    const refreshed = competitorWorkspaceSnapshot();
    if (scenario === "未完成") {
      Object.assign(refreshed.tasks[0], {
        status: "running",
        progress: 90,
        completedAt: null,
        bundleId: null,
        artifactIds: [],
      });
      refreshed.artifacts.splice(0);
      refreshed.bundles.splice(0);
    } else if (scenario === "缺包") {
      refreshed.bundles.splice(0);
    } else if (scenario === "missing" || scenario === "legacy") {
      refreshed.bundles[0].status = scenario;
    } else {
      (refreshed.bundles[0] as unknown as {
        primaryReportPath: string | null;
      }).primaryReportPath = null;
    }
    const flow = installCompletedWorkspaceFlow(finalized, refreshed);
    const user = userEvent.setup({document});
    render(<Home />);
    await user.click(screen.getByRole("button", {name: "Agent 项目"}));
    await user.click(screen.getByRole("button", {name: /竞品洞察 Agent/}));
    await user.click(screen.getByRole("button", {name: "开始竞品分析"}));
    await user.type(
      screen.getByLabelText("竞品主页或作品链接"),
      "https://www.xiaohongshu.com/explore/test-note",
    );
    await user.click(screen.getByRole("button", {name: "抓取并分析"}));
    await waitFor(() => assert.equal(flow.getRecordLoads(), 1));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      screen.getByRole("button", {name: "Agent 对话"}).getAttribute("aria-current"),
      "page",
      scenario,
    );
    assert.equal(screen.queryByRole("heading", {name: "成果包"}), null, scenario);
  }
});

test("竞品 Workspace 只提交最新 refresh 并忽略迟到旧快照", async () => {
  const oldSnapshot = competitorWorkspaceSnapshot();
  oldSnapshot.tasks[0].title = "旧快照成果包";
  const newSnapshot = competitorWorkspaceSnapshot();
  newSnapshot.tasks[0].title = "最新快照成果包";
  const first = deferredValue<Response>();
  const second = deferredValue<Response>();
  const signals: Array<AbortSignal | null> = [];
  let requestCount = 0;
  globalThis.fetch = withCompetitorHealth((input, init) => {
    const url = String(input);
    if (!url.includes("/project-records")) throw new Error(`unexpected request: ${url}`);
    requestCount += 1;
    signals.push(init?.signal ?? null);
    return requestCount === 1 ? first.promise : second.promise;
  });
  const user = userEvent.setup({document});
  render(<Home />);
  await user.click(screen.getByRole("button", {name: "Agent 项目"}));
  await user.click(screen.getByRole("button", {name: /竞品洞察 Agent/}));
  await user.click(screen.getByRole("button", {name: "任务列表"}));
  await user.click(screen.getByRole("button", {name: "成果文件"}));
  assert.equal(requestCount, 2);

  second.resolve(Response.json(newSnapshot));
  assert.ok(await screen.findByRole("heading", {name: "最新快照成果包"}));
  first.resolve(Response.json(oldSnapshot));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(screen.getByRole("heading", {name: "最新快照成果包"}));
  assert.equal(screen.queryByRole("heading", {name: "旧快照成果包"}), null);
  assertSignalAborted(signals[0]);
  assertSignalNotAborted(signals[1]);
});

test("竞品 Workspace 卸载会取消 refresh 且迟到失败不提示或切页", async () => {
  const pending = deferredValue<Response>();
  let refreshSignal: AbortSignal | null = null;
  globalThis.fetch = withCompetitorHealth((input, init) => {
    const url = String(input);
    if (!url.includes("/project-records")) throw new Error(`unexpected request: ${url}`);
    refreshSignal = init?.signal ?? null;
    return pending.promise;
  });
  const user = userEvent.setup({document});
  render(<Home />);
  await user.click(screen.getByRole("button", {name: "Agent 项目"}));
  await user.click(screen.getByRole("button", {name: /竞品洞察 Agent/}));
  await user.click(screen.getByRole("button", {name: "成果文件"}));
  assertSignalNotAborted(refreshSignal);
  await user.click(screen.getByRole("button", {name: "← 返回 Agent 项目"}));
  assertSignalAborted(refreshSignal);
  pending.reject(new Error("late-refresh-secret"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(screen.getByRole("region", {name: "9 个独立 Agent 项目"}));
  assert.doesNotMatch(document.body.textContent ?? "", /无法读取本地竞品任务记录|late-refresh-secret/u);
});

test("竞品洞察报告请求按三批生成校验并只组装一次", async () => {
  installCompetitorReportModel();
  const requests: CompetitorReportRequest[] = [];
  globalThis.fetch = withCompetitorHealth(async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({ url, init, body });
    if (url.endsWith("/analyze-artifacts")) {
      assert.deepEqual(body, {
        taskId: ACCOUNT_ANALYSIS_REQUEST.taskId,
        platformId: ACCOUNT_ANALYSIS_REQUEST.platformId,
        inputKind: ACCOUNT_ANALYSIS_REQUEST.inputKind,
        outputDir: ACCOUNT_ANALYSIS_REQUEST.outputDir,
        dataPath: ACCOUNT_ANALYSIS_REQUEST.dataPath,
        excelPath: ACCOUNT_ANALYSIS_REQUEST.excelPath,
      });
      return Response.json(evidenceReadyFixture());
    }
    if (url === "/api/agents/competitor-insight") {
      const batchId = body?.batchId as "strategy" | "performance" | "execution";
      assert.deepEqual(Object.keys(body ?? {}).sort(), ["batchId", "config", "input"]);
      assert.equal((body?.config as Record<string, unknown>).apiKey, "sk-competitor-report-secret");
      assert.deepEqual(body?.input, evidenceReadyFixture().batchInputs[batchId]);
      return Response.json({ ok: true, batch: competitorBatchFixture(batchId) });
    }
    if (url.endsWith("/validate-section")) {
      const batch = body?.batch as Record<string, unknown>;
      return Response.json({
        ok: true,
        stage: "section_validated",
        evidenceId: "0123456789abcdef",
        batchId: batch.batchId,
        batch,
      });
    }
    if (url.endsWith("/assemble-report")) {
      return Response.json(reportReadyFixture());
    }
    throw new Error(`unexpected request: ${url}`);
  });
  await openCompetitorAnalysisRequestRunner();

  await waitFor(() =>
    assert.ok(screen.getByRole("status", { name: "报告控制器完成" })),
  );
  assert.deepEqual(
    requests.filter(({url}) => !url.endsWith("/health")).map(({ url }) =>
      url === "/api/agents/competitor-insight"
        ? "model"
        : url.replace("http://127.0.0.1:8768", ""),
    ),
    [
      "/analyze-artifacts",
      "model",
      "/validate-section",
      "model",
      "/validate-section",
      "model",
      "/validate-section",
      "/assemble-report",
    ],
  );
  assert.equal(
    requests.filter(({ url }) => url.endsWith("/assemble-report")).length,
    1,
  );
  assert.equal(screen.queryByRole("region", {name: "Markdown 报告预览"}), null);
  assert.equal(screen.queryByRole("link", {name: "下载 Markdown"}), null);
  assert.doesNotMatch(
    document.body.textContent ?? "",
    /sk-competitor-report-secret/,
  );
});

test("模型未配置时任务停在报告阶段且不封装成果包", async () => {
  const calls = await runAccountLinkWithoutModel();

  await waitFor(() =>
    assert.match(
      screen.getByRole("status", { name: "竞品分析进度" }).textContent ?? "",
      /证据包已生成，等待配置模型/u,
    ),
  );
  assert.equal(calls.some((call) => call.url.endsWith("/bundle")), false);
  assert.ok(screen.getByRole("button", { name: "继续生成报告" }));
});

test("证据生成前停止会中止请求、写入终态并解锁链接入口", async () => {
  installCompetitorReportModel();
  const patches: Record<string, unknown>[] = [];
  let analyzeSignal: AbortSignal | null = null;
  let createCount = 0;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (url.endsWith("/project-tasks") && method === "POST") {
      createCount += 1;
      return Response.json({ok: true, task: persistedCompetitorTask()});
    }
    if (url.includes("/project-tasks/competitor-20260801-ui-a1") && method === "PATCH") {
      patches.push(body);
      const status = body.status as "running" | "failed";
      return Response.json({ok: true, task: persistedCompetitorTask(status)});
    }
    if (url.endsWith("/health")) return competitorHealthResponse(url);
    if (url.endsWith("/scrape")) {
      return Response.json(scrapeReadyFixture("douyin", "account"));
    }
    if (url.endsWith("/analyze-artifacts")) {
      analyzeSignal = init?.signal ?? null;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          {once: true},
        );
      });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  const user = userEvent.setup({document});
  render(
    <ModelRegistryProvider>
      <CompetitorInsightPanel mode="run" onPreview={() => undefined} />
    </ModelRegistryProvider>,
  );

  const source = screen.getByLabelText("竞品主页或作品链接") as HTMLTextAreaElement;
  await user.type(source, "https://www.douyin.com/user/MS4wLjABAAAA-test");
  await user.click(screen.getByRole("button", {name: "抓取并分析"}));
  await waitFor(() => assertSignalNotAborted(analyzeSignal));
  await user.click(screen.getByRole("button", {name: "停止生成"}));

  await waitFor(() => {
    assertSignalAborted(analyzeSignal);
    assert.equal(source.disabled, false);
    assert.equal((screen.getByRole("button", {name: "抓取并分析"}) as HTMLButtonElement).disabled, false);
    assert.match(screen.getByRole("alert").textContent ?? "", /已停止/u);
  });
  assert.equal(screen.queryByRole("button", {name: /继续生成报告|重试失败批次/u}), null);
  assert.equal(screen.queryByRole("button", {name: "停止生成"}), null);
  assert.equal(patches.at(-1)?.status, "failed");
  assert.match(String(patches.at(-1)?.errorSummary), /已停止/u);

  await user.click(screen.getByRole("button", {name: "抓取并分析"}));
  await waitFor(() => assert.equal(createCount, 2));
});

function CompetitorPanelCredentialHarness() {
  const registry = useModelRegistry();
  return (
    <>
      <button
        onClick={() => registry.saveCredential(
          "competitor-report-model",
          "sk-revised-before-evidence",
          false,
          "revision-before-evidence-new",
        )}
        type="button"
      >
        修改整理阶段模型凭据
      </button>
      <CompetitorInsightPanel mode="run" onPreview={() => undefined} />
    </>
  );
}

test("证据生成前修改模型凭据会中止请求、写入终态并解锁链接入口", async () => {
  installCompetitorReportModel();
  const patches: Record<string, unknown>[] = [];
  let analyzeSignal: AbortSignal | null = null;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (url.endsWith("/project-tasks") && method === "POST") {
      return Response.json({ok: true, task: persistedCompetitorTask()});
    }
    if (url.includes("/project-tasks/competitor-20260801-ui-a1") && method === "PATCH") {
      patches.push(body);
      const status = body.status as "running" | "failed";
      return Response.json({ok: true, task: persistedCompetitorTask(status)});
    }
    if (url.endsWith("/health")) return competitorHealthResponse(url);
    if (url.endsWith("/scrape")) {
      return Response.json(scrapeReadyFixture("douyin", "account"));
    }
    if (url.endsWith("/analyze-artifacts")) {
      analyzeSignal = init?.signal ?? null;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          {once: true},
        );
      });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  const user = userEvent.setup({document});
  render(
    <ModelRegistryProvider>
      <CompetitorPanelCredentialHarness />
    </ModelRegistryProvider>,
  );

  const source = screen.getByLabelText("竞品主页或作品链接") as HTMLTextAreaElement;
  await user.type(source, "https://www.douyin.com/user/MS4wLjABAAAA-test");
  await user.click(screen.getByRole("button", {name: "抓取并分析"}));
  await waitFor(() => assertSignalNotAborted(analyzeSignal));
  await user.click(screen.getByRole("button", {name: "修改整理阶段模型凭据"}));

  await waitFor(() => {
    assertSignalAborted(analyzeSignal);
    assert.equal(source.disabled, false);
    assert.match(screen.getByRole("alert").textContent ?? "", /模型或凭据已变化/u);
  });
  assert.equal(screen.queryByRole("button", {name: /继续生成报告|重试失败批次/u}), null);
  assert.equal(patches.at(-1)?.status, "failed");
  assert.match(String(patches.at(-1)?.errorSummary), /模型或凭据已变化/u);
});

test("失败状态写完后才恢复重试并在 running 落库后继续生成", async () => {
  installCompetitorReportModel();
  const failedPatch = deferredValue<void>();
  const runningPatch = deferredValue<void>();
  const transitions: string[] = [];
  const completed: Array<[string, string]> = [];
  let persistedStatus: "running" | "failed" | "ready" = "running";
  let modelCallCount = 0;
  let recoveryPatchStarted = false;
  let createCount = 0;
  const createdTaskIds: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (url.endsWith("/project-tasks") && method === "POST") {
      createCount += 1;
      const taskId = String(body.id);
      createdTaskIds.push(taskId);
      if (createCount > 1) transitions.push("new-task-created");
      return Response.json({
        ok: true,
        task: persistedCompetitorTask("waiting", 10, {}, taskId),
      });
    }
    if (url.includes("/project-tasks/") && method === "PATCH") {
      const taskId = url.split("/project-tasks/")[1]?.split("/")[0] ?? "";
      if (body.inputKind) {
        transitions.push(createCount === 1 ? "authoritative-running" : "new-authoritative-running");
        persistedStatus = "running";
        return Response.json({ok: true, task: persistedCompetitorTask("running", 45, {
          inputKind: "account",
          category: "douyin-account",
        }, taskId)});
      }
      if (body.status === "failed") {
        transitions.push("failed-started");
        return failedPatch.promise.then(() => {
          persistedStatus = "failed";
          transitions.push("failed-finished");
          return Response.json({
            ok: true,
            task: persistedCompetitorTask("failed", 10, {}, taskId),
          });
        });
      }
      if (body.status === "running") {
        recoveryPatchStarted = true;
        transitions.push("running-started");
        return runningPatch.promise.then(() => {
          persistedStatus = "running";
          transitions.push("running-finished");
          return Response.json({ok: true, task: persistedCompetitorTask("running", 70, {
            inputKind: "account",
            category: "douyin-account",
          }, taskId)});
        });
      }
    }
    if (url.endsWith("/health")) return competitorHealthResponse(url);
    if (url.endsWith("/scrape")) {
      return Response.json(scrapeReadyFixture("douyin", "account", String(body.taskId)));
    }
    if (url.endsWith("/analyze-artifacts")) {
      return Response.json(evidenceReadyFixture(String(body.outputDir)));
    }
    if (url === "/api/agents/competitor-insight") {
      modelCallCount += 1;
      const batchId = body.batchId as "strategy" | "performance" | "execution";
      if (batchId === "performance" && modelCallCount === 2) {
        return new Response("provider unavailable", {status: 503});
      }
      return Response.json({ok: true, batch: competitorBatchFixture(batchId)});
    }
    if (url.endsWith("/validate-section")) {
      const batch = body.batch as Record<string, unknown>;
      return Response.json({
        ok: true,
        stage: "section_validated",
        evidenceId: "0123456789abcdef",
        batchId: batch.batchId,
        batch,
      });
    }
    if (url.endsWith("/assemble-report")) return Response.json(reportReadyFixture());
    if (url.endsWith("/artifacts")) {
      const taskId = url.split("/project-tasks/")[1]?.split("/")[0] ?? "";
      return Response.json({
        ok: true,
        tasks: [persistedCompetitorTask("running", 90, {
          inputKind: "account",
          category: "douyin-account",
        }, taskId)],
        artifacts: [],
      });
    }
    if (url.endsWith("/bundle")) {
      assert.equal(persistedStatus, "running");
      persistedStatus = "ready";
      const taskId = url.split("/project-tasks/")[1]?.split("/")[0] ?? "";
      return Response.json(readyBundleSnapshot(
        "douyin",
        "account",
        String(body.outputDir),
        reportReadyFixture().reportPath,
        taskId,
      ));
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  const user = userEvent.setup({document});
  render(
    <ModelRegistryProvider>
      <CompetitorInsightPanel
        mode="run"
        onPreview={() => undefined}
        onTaskCompleted={(taskId, bundleId) => completed.push([taskId, bundleId])}
      />
    </ModelRegistryProvider>,
  );

  await user.type(
    screen.getByLabelText("竞品主页或作品链接"),
    "https://www.douyin.com/user/MS4wLjABAAAA-test",
  );
  await user.click(screen.getByRole("button", {name: "抓取并分析"}));
  const retry = await screen.findByRole("button", {name: "重试失败批次"});
  await waitFor(() => assert.deepEqual(transitions, ["authoritative-running", "failed-started"]));
  assert.equal((retry as HTMLButtonElement).disabled, true);
  assert.match(screen.getByRole("status", {name: "竞品分析进度"}).textContent ?? "", /正在同步失败状态/u);

  await user.click(retry);
  assert.equal(recoveryPatchStarted, false);
  assert.equal(modelCallCount, 2);
  runningPatch.resolve();
  assert.equal(recoveryPatchStarted, false);
  failedPatch.resolve();

  await waitFor(() => assert.equal((retry as HTMLButtonElement).disabled, false));
  await user.click(retry);
  await waitFor(() => assert.equal(createCount, 2));
  assert.equal(recoveryPatchStarted, false);
  assert.notEqual(createdTaskIds[0], createdTaskIds[1]);
  await waitFor(() => assert.deepEqual(completed, [[
    createdTaskIds[1],
    "bundle-0000000000000001",
  ]]));
  assert.deepEqual(transitions, [
    "authoritative-running",
    "failed-started",
    "failed-finished",
    "new-task-created",
    "new-authoritative-running",
  ]);
  assert.equal(persistedStatus, "ready");
  assert.equal(modelCallCount, 5);
});

test("证据生成请求挂起时卸载会中止请求并在后台收敛任务终态", async () => {
  installCompetitorReportModel();
  const patches: Record<string, unknown>[] = [];
  const previews: string[] = [];
  const completed: Array<[string, string]> = [];
  let recordsChanged = 0;
  let analyzeSignal: AbortSignal | null = null;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (url.endsWith("/project-tasks") && method === "POST") {
      return Response.json({ok: true, task: persistedCompetitorTask()});
    }
    if (url.includes("/project-tasks/competitor-20260801-ui-a1") && method === "PATCH") {
      patches.push(body);
      const status = body.status as "running" | "failed";
      return Response.json({ok: true, task: persistedCompetitorTask(status)});
    }
    if (url.endsWith("/health")) return competitorHealthResponse(url);
    if (url.endsWith("/scrape")) {
      return Response.json(scrapeReadyFixture("douyin", "account"));
    }
    if (url.endsWith("/analyze-artifacts")) {
      analyzeSignal = init?.signal ?? null;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          {once: true},
        );
      });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  const user = userEvent.setup({document});
  const view = render(
    <ModelRegistryProvider>
      <CompetitorInsightPanel
        mode="run"
        onPreview={(message) => previews.push(message)}
        onRecordsChanged={() => { recordsChanged += 1; }}
        onTaskCompleted={(taskId, bundleId) => completed.push([taskId, bundleId])}
      />
    </ModelRegistryProvider>,
  );

  await user.type(
    screen.getByLabelText("竞品主页或作品链接"),
    "https://www.douyin.com/user/MS4wLjABAAAA-test",
  );
  await user.click(screen.getByRole("button", {name: "抓取并分析"}));
  await waitFor(() => assertSignalNotAborted(analyzeSignal));
  const recordsBeforeUnmount = recordsChanged;
  view.unmount();

  await waitFor(() => {
    assertSignalAborted(analyzeSignal);
    assert.equal(patches.at(-1)?.status, "failed");
  });
  assert.match(String(patches.at(-1)?.errorSummary), /页面已关闭|分析已取消/u);
  assert.equal(recordsChanged, recordsBeforeUnmount);
  assert.deepEqual(previews, []);
  assert.deepEqual(completed, []);
});

test("成果包请求挂起时卸载会忽略迟到 ready 和全部外部回调", async () => {
  installCompetitorReportModel();
  const bundlePending = deferredValue<Response>();
  const previews: string[] = [];
  const completed: Array<[string, string]> = [];
  let recordsChanged = 0;
  let bundleStarted = false;
  const scrape = scrapeReadyFixture("xiaohongshu", "content");
  const report = {
    ...reportReadyFixture(),
    filename: "content-report.md",
    reportPath: `${scrape.outputDir}/content-report.md`,
  };
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    const recordResponse = competitorRecordTestResponse(url, init);
    if (recordResponse) return recordResponse;
    if (url.endsWith("/health")) return competitorHealthResponse(url);
    if (url.endsWith("/scrape")) return Response.json(scrape);
    if (url.endsWith("/analyze-artifacts")) return Response.json(contentEvidenceReadyFixture());
    if (url === "/api/agents/competitor-insight") {
      return Response.json({ok: true, batch: competitorBatchFixture("content")});
    }
    if (url.endsWith("/validate-section")) {
      return Response.json({
        ok: true,
        stage: "section_validated",
        evidenceId: "fedcba9876543210",
        batchId: "content",
        batch: body.batch,
      });
    }
    if (url.endsWith("/assemble-report")) return Response.json(report);
    if (url.endsWith("/bundle")) {
      bundleStarted = true;
      return bundlePending.promise;
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  const user = userEvent.setup({document});
  const view = render(
    <ModelRegistryProvider>
      <CompetitorInsightPanel
        mode="run"
        onPreview={(message) => previews.push(message)}
        onRecordsChanged={() => { recordsChanged += 1; }}
        onTaskCompleted={(taskId, bundleId) => completed.push([taskId, bundleId])}
      />
    </ModelRegistryProvider>,
  );

  await user.type(
    screen.getByLabelText("竞品主页或作品链接"),
    "https://www.xiaohongshu.com/explore/test-note",
  );
  await user.click(screen.getByRole("button", {name: "抓取并分析"}));
  await waitFor(() => assert.equal(bundleStarted, true));
  const recordsBeforeUnmount = recordsChanged;
  view.unmount();
  bundlePending.resolve(Response.json(readyBundleSnapshot(
    "xiaohongshu",
    "content",
    scrape.outputDir,
    report.reportPath,
  )));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(recordsChanged, recordsBeforeUnmount);
  assert.deepEqual(previews, []);
  assert.deepEqual(completed, []);
});

function CompetitorCredentialRevisionHarness() {
  const registry = useModelRegistry();
  const [analysisRequest, setAnalysisRequest] =
    useState<CompetitorAnalysisRequest | null>(null);
  return (
    <>
      <button
        disabled={registry.connectedModels.length === 0}
        onClick={() =>
          setAnalysisRequest(ACCOUNT_ANALYSIS_REQUEST)
        }
        type="button"
      >
        开始凭据修订测试
      </button>
      <button
        onClick={() =>
          registry.saveCredential(
            "competitor-report-model",
            "sk-revised-competitor-report",
            false,
            "revision-competitor-report-new",
          )
        }
        type="button"
      >
        修订竞品模型凭据
      </button>
      <CompetitorReportRunner analysisRequest={analysisRequest} />
    </>
  );
}

test("竞品洞察报告凭据修订变化会中止请求并丢弃迟到响应", async () => {
  installCompetitorReportModel();
  const pending = deferredValue<Response>();
  const requestedUrls: string[] = [];
  let modelSignal: AbortSignal | null = null;
  globalThis.fetch = withCompetitorHealth(async (input, init) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url.endsWith("/analyze-artifacts")) {
      return Response.json(evidenceReadyFixture());
    }
    if (url === "/api/agents/competitor-insight") {
      modelSignal = init?.signal ?? null;
      return pending.promise;
    }
    throw new Error(`unexpected request: ${url}`);
  });
  const user = userEvent.setup({ document });
  render(
    <ModelRegistryProvider>
      <CompetitorCredentialRevisionHarness />
    </ModelRegistryProvider>,
  );

  const start = screen.getByRole("button", { name: "开始凭据修订测试" });
  await waitFor(() => assert.equal((start as HTMLButtonElement).disabled, false));
  await user.click(start);
  await waitFor(() => assertSignalNotAborted(modelSignal));
  await user.click(screen.getByRole("button", { name: "修订竞品模型凭据" }));
  assertSignalAborted(modelSignal);
  pending.resolve(Response.json({
    ok: true,
    batch: competitorBatchFixture("strategy"),
  }));

  await waitFor(() =>
    assert.match(
      document.body.textContent ?? "",
      /模型或凭据已变化[\s\S]*证据包已保留/u,
    ),
  );
  assert.deepEqual(requestedUrls.filter((url) => !url.endsWith("/health")), [
    "http://127.0.0.1:8768/analyze-artifacts",
    "/api/agents/competitor-insight",
  ]);
  assert.equal(
    requestedUrls.some((url) => url.endsWith("/validate-section")),
    false,
  );
  assert.match(document.body.textContent ?? "", /0123456789abcdef/);
});

test("竞品洞察报告停止中止模型请求并保留证据包", async () => {
  installCompetitorReportModel();
  let modelSignal: AbortSignal | null = null;
  let analyzeCount = 0;
  let stopPersistCount = 0;
  const stopPersisted = deferredValue<void>();
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.endsWith("/health")) return competitorHealthResponse(url);
    if (url.endsWith("/analyze-artifacts")) {
      analyzeCount += 1;
      return Response.json(evidenceReadyFixture());
    }
    if (url === "/api/agents/competitor-insight") {
      modelSignal = init?.signal ?? null;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  const user = await openCompetitorAnalysisRequestRunner(async () => {
    stopPersistCount += 1;
    await stopPersisted.promise;
    return true;
  });

  await waitFor(() => assert.ok(screen.getByRole("button", { name: "停止生成" })));
  await user.click(screen.getByRole("button", { name: "停止生成" }));

  assertSignalAborted(modelSignal);
  await waitFor(() => assert.equal(stopPersistCount, 1));
  assert.match(document.body.textContent ?? "", /正在同步停止状态/u);
  await act(async () => {
    stopPersisted.resolve();
    await stopPersisted.promise;
  });
  await waitFor(() =>
    assert.match(document.body.textContent ?? "", /已停止[\s\S]*证据包已保留/),
  );
  assert.match(document.body.textContent ?? "", /0123456789abcdef/);
  assert.equal(analyzeCount, 1);
  assert.equal(screen.queryByRole("list", {name: "竞品报告五阶段"}), null);
});

test("Panel 停止精确落库并在 records 重挂载后保持 stopped", async () => {
  installCompetitorReportModel();
  const stopPatch = deferredValue<Response>();
  let modelSignal: AbortSignal | null = null;
  let stoppedBody: Record<string, unknown> | null = null;
  const douyinTask = (
    status: "waiting" | "running" | "stopped",
    progress: number,
    classified = status !== "waiting",
  ) => ({
    ...persistedCompetitorTask(status, progress, classified ? {
      inputKind: "account",
      category: "douyin-account",
      bundleId: null,
    } : {
      inputKind: "unknown",
      category: null,
      bundleId: null,
    }),
    title: "抖音竞品洞察",
    platformId: "douyin",
    platformLabel: "抖音",
    skillId: "douyin-scraper",
    sourceUrl: "https://www.douyin.com/user/MS4wLjABAAAA-test",
    progress,
    currentStep: status === "stopped" ? "用户已停止报告生成" : "正在生成竞品报告",
    stoppedAt: status === "stopped" ? "2026-08-01T01:03:00.000Z" : null,
  });
  const stoppedTask = douyinTask("stopped", 70);
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (url.endsWith("/health")) return competitorHealthResponse(url);
    if (url.endsWith("/project-tasks") && method === "POST") {
      return Response.json({ok: true, task: douyinTask("waiting", 10, false)});
    }
    if (url.includes("/project-tasks/competitor-20260801-ui-a1") && method === "PATCH") {
      if (body.status === "stopped") {
        stoppedBody = body;
        return stopPatch.promise;
      }
      return Response.json({ok: true, task: douyinTask("running", Number(body.progress ?? 45))});
    }
    if (url.endsWith("/scrape")) {
      return Response.json(scrapeReadyFixture("douyin", "account"));
    }
    if (url.endsWith("/analyze-artifacts")) {
      return Response.json(evidenceReadyFixture());
    }
    if (url === "/api/agents/competitor-insight") {
      modelSignal = init?.signal ?? null;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          {once: true},
        );
      });
    }
    throw new Error(`unexpected request: ${method} ${url}`);
  }) as typeof fetch;
  const user = userEvent.setup({document});
  const view = render(
    <ModelRegistryProvider>
      <CompetitorInsightPanel mode="run" onPreview={() => undefined} />
    </ModelRegistryProvider>,
  );
  const source = screen.getByLabelText("竞品主页或作品链接") as HTMLTextAreaElement;
  await user.type(source, "https://www.douyin.com/user/MS4wLjABAAAA-test");
  await user.click(screen.getByRole("button", {name: "抓取并分析"}));
  await waitFor(() => assertSignalNotAborted(modelSignal));
  await user.click(screen.getByRole("button", {name: "停止生成"}));

  await waitFor(() => assert.deepEqual(stoppedBody, {
    status: "stopped",
    progress: 70,
    currentStep: "用户已停止报告生成",
    errorSummary: null,
  }));
  assertSignalAborted(modelSignal);
  assert.equal(source.disabled, true);
  assert.match(document.body.textContent ?? "", /正在同步停止状态/u);
  await act(async () => {
    stopPatch.resolve(Response.json({ok: true, task: stoppedTask}));
    await stopPatch.promise;
  });
  await waitFor(() => {
    assert.equal(source.disabled, false);
    assert.match(document.body.textContent ?? "", /已停止[\s\S]*证据包已保留/u);
  });
  view.unmount();

  globalThis.fetch = withCompetitorHealth(async (input) => {
    const url = String(input);
    if (url.includes("/project-records")) {
      return Response.json({ok: true, tasks: [stoppedTask], artifacts: [], bundles: []});
    }
    throw new Error(`unexpected request after remount: ${url}`);
  });
  const remountUser = userEvent.setup({document});
  render(<Home />);
  await remountUser.click(screen.getByRole("button", {name: "Agent 项目"}));
  await remountUser.click(screen.getByRole("button", {name: /竞品洞察 Agent/}));
  await remountUser.click(screen.getByRole("button", {name: "任务列表"}));
  await screen.findByText("抖音竞品洞察");
  assert.match(document.body.textContent ?? "", /已停止/u);
  assert.equal(screen.queryByRole("button", {name: /继续生成报告|重试失败批次/u}), null);
});

test("竞品洞察报告失败批次重试从原批次继续且不重复上传", async () => {
  installCompetitorReportModel();
  const batchIds = [
    "strategy",
    "performance",
    "performance",
    "execution",
  ] as const;
  let providerIndex = 0;
  let analyzeCount = 0;
  let shouldFailPerformance = true;
  globalThis.fetch = withCompetitorHealth(async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (url.endsWith("/analyze-artifacts")) {
      analyzeCount += 1;
      return Response.json(evidenceReadyFixture());
    }
    if (url === "/api/agents/competitor-insight") {
      const batchId = batchIds[providerIndex++] ?? "execution";
      if (batchId === "performance" && shouldFailPerformance) {
        shouldFailPerformance = false;
        return new Response("provider unavailable", { status: 503 });
      }
      return Response.json({ ok: true, batch: competitorBatchFixture(batchId) });
    }
    if (url.endsWith("/validate-section")) {
      const batch = body?.batch as Record<string, unknown>;
      return Response.json({
        ok: true,
        stage: "section_validated",
        evidenceId: "0123456789abcdef",
        batchId: batch.batchId,
        batch,
      });
    }
    if (url.endsWith("/assemble-report")) {
      return Response.json(reportReadyFixture());
    }
    throw new Error(`unexpected request: ${url}`);
  });
  const user = await openCompetitorAnalysisRequestRunner();

  const retry = await screen.findByRole("button", { name: "重试失败批次" });
  assert.match(screen.getByRole("alert").textContent ?? "", /数据表现批次/);
  await user.click(retry);
  await waitFor(() =>
    assert.ok(screen.getByRole("status", { name: "报告控制器完成" })),
  );

  assert.equal(analyzeCount, 1);
  assert.deepEqual(batchIds.slice(0, providerIndex), [
    "strategy",
    "performance",
    "performance",
    "execution",
  ]);
});

test("竞品报告模型首次格式错误会自动重试一次且携带账号上下文", async () => {
  installCompetitorReportModel();
  const modelBatchIds: string[] = [];
  let strategyAttempts = 0;
  globalThis.fetch = withCompetitorHealth(async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (url.endsWith("/analyze-artifacts")) return Response.json(evidenceReadyFixture());
    if (url === "/api/agents/competitor-insight") {
      modelBatchIds.push(body?.batchId);
      if (body?.batchId === "strategy") {
        assert.deepEqual(body.input.account, evidenceReadyFixture().account);
        strategyAttempts += 1;
        if (strategyAttempts === 1) {
          return Response.json({ ok: true, batch: {} });
        }
      } else {
        assert.equal(body.input.account, undefined);
      }
      return Response.json({ ok: true, batch: competitorBatchFixture(body.batchId) });
    }
    if (url.endsWith("/validate-section")) {
      return Response.json({
        ok: true,
        stage: "section_validated",
        evidenceId: "0123456789abcdef",
        batchId: body.batch.batchId,
        batch: body.batch,
      });
    }
    if (url.endsWith("/assemble-report")) return Response.json(reportReadyFixture());
    throw new Error(`unexpected request: ${url}`);
  });
  await openCompetitorAnalysisRequestRunner();

  await screen.findByRole("status", { name: "报告控制器完成" });
  assert.deepEqual(modelBatchIds, ["strategy", "strategy", "performance", "execution"]);
});

test("竞品报告章节校验首次失败会只自动重试当前批次", async () => {
  installCompetitorReportModel();
  const modelBatchIds: string[] = [];
  let validationAttempts = 0;
  globalThis.fetch = withCompetitorHealth(async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (url.endsWith("/analyze-artifacts")) return Response.json(evidenceReadyFixture());
    if (url === "/api/agents/competitor-insight") {
      modelBatchIds.push(body.batchId);
      return Response.json({ ok: true, batch: competitorBatchFixture(body.batchId) });
    }
    if (url.endsWith("/validate-section")) {
      validationAttempts += 1;
      if (validationAttempts === 1) {
        return Response.json({ ok: false, error: "INVALID_SECTION", message: "safe" }, { status: 400 });
      }
      return Response.json({ ok: true, stage: "section_validated", evidenceId: "0123456789abcdef", batchId: body.batch.batchId, batch: body.batch });
    }
    if (url.endsWith("/assemble-report")) return Response.json(reportReadyFixture());
    throw new Error(`unexpected request: ${url}`);
  });
  await openCompetitorAnalysisRequestRunner();

  await screen.findByRole("status", { name: "报告控制器完成" });
  assert.deepEqual(modelBatchIds, ["strategy", "strategy", "performance", "execution"]);
});

test("竞品报告同一批两次格式错误后失败且不进入后续批次", async () => {
  installCompetitorReportModel();
  let modelCalls = 0;
  globalThis.fetch = withCompetitorHealth(async (input) => {
    const url = String(input);
    if (url.endsWith("/analyze-artifacts")) return Response.json(evidenceReadyFixture());
    if (url === "/api/agents/competitor-insight") {
      modelCalls += 1;
      return Response.json({ ok: true, batch: {} });
    }
    throw new Error(`unexpected request: ${url}`);
  });
  await openCompetitorAnalysisRequestRunner();

  await screen.findByRole("button", { name: "重试失败批次" });
  assert.equal(modelCalls, 2);
});

test("竞品报告运营错误不自动重试", async () => {
  installCompetitorReportModel();
  let modelCalls = 0;
  globalThis.fetch = withCompetitorHealth(async (input) => {
    const url = String(input);
    if (url.endsWith("/analyze-artifacts")) return Response.json(evidenceReadyFixture());
    if (url === "/api/agents/competitor-insight") {
      modelCalls += 1;
      return new Response("rate limited", { status: 429 });
    }
    throw new Error(`unexpected request: ${url}`);
  });
  await openCompetitorAnalysisRequestRunner();

  await screen.findByRole("button", { name: "重试失败批次" });
  assert.equal(modelCalls, 1);
});

test("竞品报告两次尝试之间停止会阻止第二次请求", async () => {
  installCompetitorReportModel();
  let modelCalls = 0;
  globalThis.fetch = withCompetitorHealth(async (input) => {
    const url = String(input);
    if (url.endsWith("/analyze-artifacts")) return Response.json(evidenceReadyFixture());
    if (url === "/api/agents/competitor-insight") {
      modelCalls += 1;
      fireEvent.click(screen.getByRole("button", { name: "停止生成" }));
      return Response.json({ ok: true, batch: {} });
    }
    throw new Error(`unexpected request: ${url}`);
  });
  await openCompetitorAnalysisRequestRunner();

  await waitFor(() => assert.match(document.body.textContent ?? "", /已停止/));
  assert.equal(modelCalls, 1);
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
