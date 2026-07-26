import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { JSDOM } from "jsdom";

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

const { cleanup, render, screen } = await import("@testing-library/react");
const { default: userEvent } = await import("@testing-library/user-event");
const { AGENT_PROJECTS } = await import("../app/lib/agent-catalog.mjs");
const { default: Home } = await import("../app/page");

let storageAccesses = 0;
let originalFetch: typeof fetch;
let originalCreateObjectURL: typeof URL.createObjectURL | undefined;
let originalRevokeObjectURL: typeof URL.revokeObjectURL | undefined;

beforeEach(() => {
  storageAccesses = 0;
  originalFetch = globalThis.fetch;
  originalCreateObjectURL = URL.createObjectURL;
  originalRevokeObjectURL = URL.revokeObjectURL;
  URL.createObjectURL = () => "blob:content-matrix-result";
  URL.revokeObjectURL = () => undefined;

  for (const storage of [window.localStorage, window.sessionStorage]) {
    for (const method of ["getItem", "setItem", "removeItem", "clear"] as const) {
      Object.defineProperty(storage, method, {
        configurable: true,
        value: () => {
          storageAccesses += 1;
          throw new Error("内容矩阵配置不得访问浏览器存储");
        },
      });
    }
  }
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  globalThis.fetch = originalFetch;
  if (originalCreateObjectURL) URL.createObjectURL = originalCreateObjectURL;
  else delete (URL as { createObjectURL?: typeof URL.createObjectURL }).createObjectURL;
  if (originalRevokeObjectURL) URL.revokeObjectURL = originalRevokeObjectURL;
  else delete (URL as { revokeObjectURL?: typeof URL.revokeObjectURL }).revokeObjectURL;
});

async function openContentMatrix(user: ReturnType<typeof userEvent.setup>) {
  render(<Home />);
  await user.click(screen.getByRole("button", { name: /内容矩阵 Agent/ }));
}

async function openContentMatrixConfig(user: ReturnType<typeof userEvent.setup>) {
  await openContentMatrix(user);
  await user.click(screen.getByRole("button", { name: "Agent 配置" }));
}

async function fillCompleteDiagnosis(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByLabelText("小红书"));
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
  await user.click(screen.getByLabelText("强监管行业"));
  await user.click(screen.getByRole("button", { name: "提交诊断" }));
}

async function fillAndApplyConfig(
  user: ReturnType<typeof userEvent.setup>,
  apiKey = "sk-ui-secret",
) {
  await user.selectOptions(screen.getByLabelText("服务商预设"), "openai");
  await user.clear(screen.getByLabelText("模型名称"));
  await user.type(screen.getByLabelText("模型名称"), "gpt-test");
  await user.type(screen.getByLabelText("API Key"), apiKey);
  await user.click(screen.getByRole("button", { name: "测试连接" }));
  await screen.findByText("连接测试成功，模型可用");
  await user.click(screen.getByRole("button", { name: "应用到当前会话" }));
  await screen.findByText(/当前会话已应用/);
}

test("only content matrix exposes temporary API configuration and requires a successful connection test before applying", async () => {
  const user = userEvent.setup({ document });
  const requests: Array<Record<string, unknown>> = [];
  let shouldFail = true;
  globalThis.fetch = async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)));
    if (shouldFail) {
      return new Response(JSON.stringify({
        ok: false,
        error: {
          code: "AUTH_FAILED",
          message: "模型服务鉴权失败，请检查 API Key：sk-ui-secret",
        },
      }), { status: 401, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      ok: true,
      action: "test",
      connected: true,
      modelAvailable: true,
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  await openContentMatrixConfig(user);

  assert.ok(screen.getByRole("heading", { name: "内容矩阵 Agent · 当前会话模型" }));
  const keyInput = screen.getByLabelText("API Key");
  assert.equal(keyInput.getAttribute("type"), "password");
  assert.match(
    screen.getByText(/Key 只保留在当前页面内存/).textContent ?? "",
    /刷新即清空.*服务端代理/,
  );
  assert.equal(
    screen.getByRole("button", { name: "应用到当前会话" }).hasAttribute("disabled"),
    true,
  );

  await user.selectOptions(screen.getByLabelText("服务商预设"), "custom");
  await user.selectOptions(screen.getByLabelText("协议"), "anthropic");
  await user.clear(screen.getByLabelText("API 地址"));
  await user.type(screen.getByLabelText("API 地址"), "https://models.example.com/v1");
  await user.type(keyInput, "sk-ui-secret");
  await user.clear(screen.getByLabelText("模型名称"));
  await user.type(screen.getByLabelText("模型名称"), "claude-test");
  await user.click(screen.getByRole("button", { name: "测试连接" }));

  assert.match(screen.getByRole("alert").textContent ?? "", /鉴权失败/);
  assert.equal(document.documentElement.outerHTML.includes("sk-ui-secret"), false);
  assert.equal(
    screen.getByRole("button", { name: "应用到当前会话" }).hasAttribute("disabled"),
    true,
  );
  assert.deepEqual(requests[0], {
    action: "test",
    protocol: "anthropic",
    baseUrl: "https://models.example.com/v1",
    apiKey: "sk-ui-secret",
    model: "claude-test",
  });

  shouldFail = false;
  await user.click(screen.getByRole("button", { name: "测试连接" }));
  await screen.findByText("连接测试成功，模型可用");
  assert.equal(
    screen.getByRole("button", { name: "应用到当前会话" }).hasAttribute("disabled"),
    false,
  );
  await user.click(screen.getByRole("button", { name: "应用到当前会话" }));
  assert.match(screen.getByText(/当前会话已应用/).textContent ?? "", /claude-test/);
  assert.equal(storageAccesses, 0);

  await user.click(screen.getByRole("button", { name: "← 返回 Agent 项目" }));
  for (const otherAgent of AGENT_PROJECTS.filter(
    (agent: { id: string }) => agent.id !== "content-matrix",
  )) {
    await user.click(screen.getByRole("button", { name: new RegExp(otherAgent.title) }));
    await user.click(screen.getByRole("button", { name: "Agent 配置" }));
    assert.ok(
      screen.getByRole("heading", {
        name: `${otherAgent.title} · Agent 默认模型`,
      }),
    );
    assert.equal(screen.queryByLabelText("API Key"), null);
    await user.click(screen.getByRole("button", { name: "← 返回 Agent 项目" }));
  }
  await user.click(screen.getByRole("button", { name: "模型配置" }));
  assert.ok(screen.getByRole("heading", { name: "全局可用模型" }));
  assert.equal(screen.queryByLabelText("API Key"), null);
});

test("blocks model execution until configuration and diagnosis are both ready", async () => {
  const user = userEvent.setup({ document });
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    throw new Error("不应调用");
  };

  await openContentMatrix(user);
  await user.click(screen.getByRole("button", { name: "开始矩阵诊断" }));
  assert.match(screen.getByRole("status", { name: "内容矩阵模型状态" }).textContent ?? "", /尚未配置/);
  await user.click(screen.getByRole("button", { name: "前往 Agent 配置" }));
  assert.ok(screen.getByRole("heading", { name: "内容矩阵 Agent · 当前会话模型" }));

  await user.click(screen.getByRole("button", { name: "Agent 对话" }));
  await fillCompleteDiagnosis(user);
  const startButton = screen.getByRole("button", { name: "开始战略分析" });
  assert.equal(startButton.hasAttribute("disabled"), true);
  assert.match(screen.getByText(/请先完成当前会话模型配置/).textContent ?? "", /Agent 配置/);
  assert.equal(requestCount, 0);
  assert.equal(storageAccesses, 0);
});

test("runs stages 2 through 5 in order, keeps completed output on retry, prevents duplicate submission, and downloads only final markdown", async () => {
  const user = userEvent.setup({ document });
  const requests: Array<Record<string, unknown>> = [];
  let stage3Attempts = 0;
  let releaseStage4: (() => void) | undefined;
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push(body);
    if (body.action === "test") {
      return new Response(JSON.stringify({
        ok: true,
        action: "test",
        connected: true,
        modelAvailable: true,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (body.stage === 3 && stage3Attempts++ === 0) {
      return new Response(JSON.stringify({
        ok: false,
        error: { code: "RATE_LIMITED", message: "模型服务请求过于频繁，请稍后重试。" },
      }), { status: 429, headers: { "content-type": "application/json" } });
    }
    if (body.stage === 4) {
      await new Promise<void>((resolve) => {
        releaseStage4 = resolve;
      });
    }
    const stage = Number(body.stage);
    return new Response(JSON.stringify({
      ok: true,
      action: "run",
      stage,
      markdown: `# 阶段 ${stage}\n阶段 ${stage} 的安全结果\nsk-ui-secret`,
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  await openContentMatrixConfig(user);
  await fillAndApplyConfig(user);
  await user.click(screen.getByRole("button", { name: "Agent 对话" }));
  assert.match(screen.getByRole("status", { name: "内容矩阵模型状态" }).textContent ?? "", /gpt-test.*可运行/);
  await fillCompleteDiagnosis(user);

  await user.click(screen.getByRole("button", { name: "开始战略分析" }));
  assert.ok(await screen.findByRole("heading", { name: "第二阶段 · 战略判断" }));
  await user.type(screen.getByLabelText("第二阶段修改意见"), "战略部分强调搜索入口");
  await user.click(screen.getByRole("button", { name: "确认战略并进入账号设计" }));
  assert.match(await screen.findByRole("alert").then((node) => node.textContent ?? ""), /请求过于频繁/);
  assert.ok(screen.getByRole("heading", { name: "第二阶段 · 战略判断" }));
  assert.ok(screen.getByDisplayValue("战略部分强调搜索入口"));

  await user.click(screen.getByRole("button", { name: "重试账号设计" }));
  assert.ok(await screen.findByRole("heading", { name: "第三阶段 · 账号分层与人设包装" }));
  await user.type(screen.getByLabelText("第三阶段修改意见"), "品牌号只做正式承接");
  await user.click(screen.getByRole("button", { name: "确认战术并进入执行 SOP" }));
  const runningButton = screen.getByRole("button", { name: "正在生成执行 SOP…" });
  assert.equal(runningButton.hasAttribute("disabled"), true);
  await user.click(runningButton);
  assert.equal(requests.filter((request) => request.stage === 4).length, 1);
  assert.ok(releaseStage4);
  releaseStage4?.();
  assert.ok(await screen.findByRole("heading", { name: "第四阶段 · 内容裂变与起号 SOP" }));

  await user.type(screen.getByLabelText("第四阶段修改意见"), "增加相对止损口径");
  await user.click(screen.getByRole("button", { name: "确认执行方案并生成正式成品" }));
  assert.ok(await screen.findByRole("heading", { name: "第五阶段 · 正式矩阵方案" }));
  const download = screen.getByRole("link", { name: "下载 Markdown" });
  assert.equal(download.getAttribute("download"), "内容矩阵正式方案.md");
  assert.equal(download.getAttribute("href"), "blob:content-matrix-result");

  const runRequests = requests.filter((request) => request.action === "run");
  assert.deepEqual(runRequests.map((request) => request.stage), [2, 3, 3, 4, 5]);
  assert.equal(runRequests[0].confirmed, undefined);
  assert.deepEqual(
    runRequests.slice(1).map((request) => [request.confirmed, request.confirmedStage]),
    [[true, 2], [true, 2], [true, 3], [true, 4]],
  );
  assert.equal((runRequests[0].history as unknown[]).length, 0);
  assert.equal((runRequests[1].history as unknown[]).length, 1);
  assert.equal(JSON.stringify(runRequests[1].history).includes("sk-ui-secret"), false);
  assert.equal((runRequests[3].history as unknown[]).length, 2);
  assert.equal((runRequests[4].history as unknown[]).length, 3);
  assert.equal(runRequests[1].feedback, "战略部分强调搜索入口");
  assert.equal(runRequests[3].feedback, "品牌号只做正式承接");
  assert.equal(runRequests[4].feedback, "增加相对止损口径");
  assert.equal(document.documentElement.outerHTML.includes("sk-ui-secret"), false);
  assert.equal(storageAccesses, 0);
});

test("clearing the current-session configuration blocks further calls while preserving non-sensitive stage output", async () => {
  const user = userEvent.setup({ document });
  let requestCount = 0;
  globalThis.fetch = async (_input, init) => {
    requestCount += 1;
    const body = JSON.parse(String(init?.body));
    if (body.action === "test") {
      return new Response(JSON.stringify({
        ok: true,
        action: "test",
        connected: true,
        modelAvailable: true,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      ok: true,
      action: "run",
      stage: 2,
      markdown: "# 已完成战略\n保留这份非敏感结果",
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  await openContentMatrixConfig(user);
  await fillAndApplyConfig(user);
  await user.click(screen.getByRole("button", { name: "Agent 对话" }));
  await fillCompleteDiagnosis(user);
  await user.click(screen.getByRole("button", { name: "开始战略分析" }));
  assert.ok(await screen.findByText(/保留这份非敏感结果/));

  await user.click(screen.getByRole("button", { name: "Agent 配置" }));
  await user.click(screen.getByRole("button", { name: "清空当前会话配置" }));
  assert.match(screen.getByRole("status").textContent ?? "", /已清空/);
  await user.click(screen.getByRole("button", { name: "Agent 对话" }));
  assert.ok(screen.getByText(/保留这份非敏感结果/));
  const continueButton = screen.getByRole("button", { name: "确认战略并进入账号设计" });
  assert.equal(continueButton.hasAttribute("disabled"), true);
  assert.match(screen.getByRole("status", { name: "内容矩阵模型状态" }).textContent ?? "", /尚未配置/);
  assert.equal(requestCount, 2);
  assert.equal(storageAccesses, 0);
});
