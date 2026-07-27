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

const { act, cleanup, render, screen } = await import("@testing-library/react");
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

async function prepareRunnableMatrix(user: ReturnType<typeof userEvent.setup>) {
  await openContentMatrixConfig(user);
  await fillAndApplyConfig(user);
  await user.click(screen.getByRole("button", { name: "Agent 对话" }));
  await fillCompleteDiagnosis(user);
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

test("APINebula CODEX preset uses the recommended endpoint and adds a safe actionable outage hint", async () => {
  const user = userEvent.setup({ document });
  const fakeKey = "sk-fake-apinebula-secret";
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = async (input, init) => {
    requests.push({
      url: String(input),
      body: JSON.parse(String(init?.body)),
    });
    return new Response(
      `upstream https://apinebula.ai/v1 failed with ${fakeKey}`,
      { status: 503 },
    );
  };

  await openContentMatrixConfig(user);
  await user.type(screen.getByLabelText("API Key"), "discarded-fake-key");
  await user.selectOptions(
    screen.getByLabelText("服务商预设"),
    "apinebula-codex",
  );

  assert.equal(
    (screen.getByLabelText("协议") as HTMLSelectElement).value,
    "openai-compatible",
  );
  assert.equal(
    (screen.getByLabelText("API 地址") as HTMLInputElement).value,
    "https://apinebula.ai/v1",
  );
  assert.equal(
    (screen.getByLabelText("模型名称") as HTMLInputElement).value,
    "gpt-5.5",
  );
  assert.equal(
    (screen.getByLabelText("API Key") as HTMLInputElement).value,
    "",
  );
  assert.ok(screen.getByRole("button", { name: "测试文案模型" }));
  assert.match(
    screen.getByText(/固定短消息/).textContent ?? "",
    /可能产生极少量模型调用费用/,
  );

  await user.type(screen.getByLabelText("API Key"), fakeKey);
  await user.click(screen.getByRole("button", { name: "测试文案模型" }));

  const alert = await screen.findByRole("alert");
  assert.equal(
    alert.textContent,
    "模型服务暂时不可用，请稍后重试。",
  );
  assert.equal(alert.textContent?.includes(fakeKey), false);
  assert.equal(alert.textContent?.includes("apinebula.ai"), false);
  assert.equal(requests[0].url, "https://apinebula.ai/v1/chat/completions");
  assert.deepEqual(requests[0].body, {
    model: "gpt-5.5",
    messages: [
      { role: "system", content: "你是接口连通性测试助手。" },
      { role: "user", content: "只回复：连接正常" },
    ],
    max_tokens: 32,
  });
  assert.equal(storageAccesses, 0);

  await user.click(screen.getByRole("button", { name: "← 返回 Agent 项目" }));
  const otherAgent = AGENT_PROJECTS.find(
    (agent: { id: string }) => agent.id !== "content-matrix",
  );
  assert.ok(otherAgent);
  await user.click(
    screen.getByRole("button", { name: new RegExp(otherAgent.title) }),
  );
  await user.click(screen.getByRole("button", { name: "Agent 配置" }));
  assert.equal(
    screen.queryByRole("option", { name: "APINebula（CODEX）" }),
    null,
  );
  assert.equal(screen.queryByLabelText("API Key"), null);
});

test("APINebula probe disclosure follows the effective protocol and exact hostname", async () => {
  const user = userEvent.setup({ document });
  await openContentMatrixConfig(user);
  await user.selectOptions(
    screen.getByLabelText("服务商预设"),
    "apinebula-codex",
  );

  assert.ok(screen.getByRole("button", { name: "测试文案模型" }));
  assert.ok(screen.getByText(/可能产生极少量模型调用费用/));

  await user.selectOptions(screen.getByLabelText("协议"), "anthropic");
  assert.ok(screen.getByRole("button", { name: "测试连接" }));
  assert.equal(screen.queryByText(/可能产生极少量模型调用费用/), null);

  await user.selectOptions(screen.getByLabelText("协议"), "openai-compatible");
  await user.clear(screen.getByLabelText("API 地址"));
  await user.type(
    screen.getByLabelText("API 地址"),
    "https://apinebula.ai.evil.example/v1",
  );
  assert.ok(screen.getByRole("button", { name: "测试连接" }));
  assert.equal(screen.queryByText(/可能产生极少量模型调用费用/), null);

  await user.selectOptions(screen.getByLabelText("服务商预设"), "custom");
  await user.clear(screen.getByLabelText("API 地址"));
  await user.type(
    screen.getByLabelText("API 地址"),
    "https://apinebula.ai/v1",
  );
  assert.ok(screen.getByRole("button", { name: "测试文案模型" }));
  assert.ok(screen.getByText(/可能产生极少量模型调用费用/));
  assert.equal(storageAccesses, 0);
});

test("APINebula tests and runs content matrix stages directly in the browser without sending the Key to the workbench route", async () => {
  const user = userEvent.setup({ document });
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fakeKey = "sk-direct-browser-only";
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    const body = JSON.parse(String(init?.body));
    const isProbe = body.messages?.[0]?.content === "你是接口连通性测试助手。";
    const isStageThree = /第三阶段/.test(body.messages?.[0]?.content ?? "");
    return new Response(JSON.stringify({
      id: isProbe ? "chatcmpl-probe" : "chatcmpl-stage",
      object: "chat.completion",
      created: 1,
      model: "gpt-5.5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: isProbe
              ? "连接正常"
              : isStageThree
                ? "## 账号配置\n浏览器直连第三阶段结果"
                : "## 战略判断\n浏览器直连阶段结果",
          },
          finish_reason: "stop",
        },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  await openContentMatrixConfig(user);
  await user.selectOptions(
    screen.getByLabelText("服务商预设"),
    "apinebula-codex",
  );
  assert.match(
    screen.getByText(/浏览器直接发送至APINebula官方域名/).textContent ?? "",
    /Key不经过工作台服务端.*极少量费用/,
  );
  await user.type(screen.getByLabelText("API Key"), fakeKey);
  await user.click(screen.getByRole("button", { name: "测试文案模型" }));
  await screen.findByText("连接测试成功，模型可用");
  await user.click(screen.getByRole("button", { name: "应用到当前会话" }));
  await user.click(screen.getByRole("button", { name: "Agent 对话" }));
  await fillCompleteDiagnosis(user);
  await user.click(screen.getByRole("button", { name: "开始战略分析" }));
  assert.ok(await screen.findByText(/浏览器直连阶段结果/));
  await user.click(
    screen.getByRole("button", { name: "确认战略并进入账号设计" }),
  );
  assert.ok(await screen.findByText(/浏览器直连第三阶段结果/));

  assert.equal(requests.length, 3);
  assert.deepEqual(
    requests.map(({ url }) => url),
    [
      "https://apinebula.ai/v1/chat/completions",
      "https://apinebula.ai/v1/chat/completions",
      "https://apinebula.ai/v1/chat/completions",
    ],
  );
  assert.equal(
    requests.some(({ url }) => url.includes("/api/agents/content-matrix")),
    false,
  );
  const probeBody = JSON.parse(String(requests[0].init?.body));
  assert.deepEqual(probeBody, {
    model: "gpt-5.5",
    messages: [
      { role: "system", content: "你是接口连通性测试助手。" },
      { role: "user", content: "只回复：连接正常" },
    ],
    max_tokens: 32,
  });
  const stageBody = JSON.parse(String(requests[1].init?.body));
  assert.match(stageBody.messages[0].content, /第二阶段/);
  assert.match(stageBody.messages[1].content, /全国可发货/);
  assert.equal(JSON.stringify(stageBody).includes(fakeKey), false);
  const stageThreeBody = JSON.parse(String(requests[2].init?.body));
  assert.match(stageThreeBody.messages[0].content, /第三阶段/);
  assert.match(stageThreeBody.messages[1].content, /浏览器直连阶段结果/);
  assert.equal(
    new Headers(requests[0].init?.headers).get("authorization"),
    `Bearer ${fakeKey}`,
  );
  assert.equal(document.documentElement.outerHTML.includes(fakeKey), false);
  assert.equal(storageAccesses, 0);
});

test("non-APINebula providers keep using the workbench server proxy", async () => {
  const user = userEvent.setup({ document });
  const urls: string[] = [];
  globalThis.fetch = async (input) => {
    urls.push(String(input));
    return new Response(JSON.stringify({
      ok: true,
      action: "test",
      connected: true,
      modelAvailable: true,
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  await openContentMatrixConfig(user);
  await user.type(screen.getByLabelText("API Key"), "sk-server-proxy-only");
  await user.click(screen.getByRole("button", { name: "测试连接" }));
  await screen.findByText("连接测试成功，模型可用");

  assert.deepEqual(urls, ["/api/agents/content-matrix"]);
  assert.match(
    screen.getByText(/模型请求会经过工作台服务端代理/).textContent ?? "",
    /刷新即清空/,
  );
  assert.equal(storageAccesses, 0);
});

test("APINebula browser-direct failures show only safe runtime errors", async () => {
  const user = userEvent.setup({ document });
  const fakeKey = "sk-provider-must-not-reflect";
  globalThis.fetch = async () =>
    new Response(`provider rejected ${fakeKey} at https://apinebula.ai/v1`, {
      status: 401,
    });

  await openContentMatrixConfig(user);
  await user.selectOptions(
    screen.getByLabelText("服务商预设"),
    "apinebula-codex",
  );
  await user.type(screen.getByLabelText("API Key"), fakeKey);
  await user.click(screen.getByRole("button", { name: "测试文案模型" }));

  const alert = await screen.findByRole("alert");
  assert.match(alert.textContent ?? "", /鉴权失败/);
  assert.equal(alert.textContent?.includes(fakeKey), false);
  assert.equal(alert.textContent?.includes("provider rejected"), false);
  assert.equal(alert.textContent?.includes("apinebula.ai"), false);
  assert.equal(document.documentElement.outerHTML.includes(fakeKey), false);
  assert.equal(storageAccesses, 0);
});

test("ignores a successful connection response that arrives after the draft configuration changes", async () => {
  const user = userEvent.setup({ document });
  let releaseResponse: (() => void) | undefined;
  globalThis.fetch = async () => {
    await new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    return new Response(JSON.stringify({
      ok: true,
      action: "test",
      connected: true,
      modelAvailable: true,
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  await openContentMatrixConfig(user);
  await user.type(screen.getByLabelText("API Key"), "sk-stale-secret");
  await user.click(screen.getByRole("button", { name: "测试连接" }));
  assert.ok(screen.getByRole("button", { name: "正在测试…" }));

  await user.clear(screen.getByLabelText("模型名称"));
  await user.type(screen.getByLabelText("模型名称"), "gpt-new-draft");
  assert.match(screen.getByRole("status").textContent ?? "", /配置已修改/);
  assert.ok(releaseResponse);
  await act(async () => {
    releaseResponse?.();
    await Promise.resolve();
  });

  assert.match(screen.getByRole("status").textContent ?? "", /配置已修改/);
  assert.equal(screen.queryByText("连接测试成功，模型可用"), null);
  assert.equal(
    screen.getByRole("button", { name: "应用到当前会话" }).hasAttribute("disabled"),
    true,
  );
  assert.equal(document.documentElement.outerHTML.includes("sk-stale-secret"), false);
  assert.equal(storageAccesses, 0);
});

test("ignores a successful connection response that arrives after the session configuration is cleared", async () => {
  const user = userEvent.setup({ document });
  let releaseResponse: (() => void) | undefined;
  globalThis.fetch = async () => {
    await new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    return new Response(JSON.stringify({
      ok: true,
      action: "test",
      connected: true,
      modelAvailable: true,
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  await openContentMatrixConfig(user);
  await user.type(screen.getByLabelText("API Key"), "sk-cleared-secret");
  await user.click(screen.getByRole("button", { name: "测试连接" }));
  assert.ok(screen.getByRole("button", { name: "正在测试…" }));

  await user.click(screen.getByRole("button", { name: "清空当前会话配置" }));
  assert.match(screen.getByRole("status").textContent ?? "", /已清空/);
  assert.ok(releaseResponse);
  await act(async () => {
    releaseResponse?.();
    await Promise.resolve();
  });

  assert.match(screen.getByRole("status").textContent ?? "", /已清空/);
  assert.equal(screen.queryByText("连接测试成功，模型可用"), null);
  assert.equal(
    screen.getByRole("button", { name: "应用到当前会话" }).hasAttribute("disabled"),
    true,
  );
  assert.equal(document.documentElement.outerHTML.includes("sk-cleared-secret"), false);
  assert.equal(storageAccesses, 0);
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

test("regenerates the current stage from feedback without advancing, then advances only after explicit confirmation", async () => {
  const user = userEvent.setup({ document });
  const requests: Array<Record<string, unknown>> = [];
  let releaseStaleRegeneration: (() => void) | undefined;
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
    if (body.stage === 2 && body.feedback === "先强调旧意见") {
      await new Promise<void>((resolve) => {
        releaseStaleRegeneration = resolve;
      });
    }
    const stage = Number(body.stage);
    const feedback = String(body.feedback || "");
    return new Response(JSON.stringify({
      ok: true,
      action: "run",
      stage,
      markdown: feedback
        ? `# 阶段 ${stage} 修订版\n已采用：${feedback}`
        : `# 阶段 ${stage} 初版`,
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  await prepareRunnableMatrix(user);
  await user.click(screen.getByRole("button", { name: "开始战略分析" }));
  assert.ok(await screen.findByText(/阶段 2 初版/));

  await user.type(screen.getByLabelText("第二阶段修改意见"), "先强调旧意见");
  assert.ok(screen.getByRole("button", { name: "按意见重生成当前阶段" }));
  assert.equal(
    screen.getByRole("button", { name: "确认战略并进入账号设计" }).hasAttribute("disabled"),
    true,
  );
  await user.click(screen.getByRole("button", { name: "按意见重生成当前阶段" }));
  assert.ok(screen.getByRole("button", { name: "正在按意见重生成…" }));

  await user.clear(screen.getByLabelText("第二阶段修改意见"));
  await user.type(screen.getByLabelText("第二阶段修改意见"), "改用最新意见");
  assert.ok(releaseStaleRegeneration);
  await act(async () => {
    releaseStaleRegeneration?.();
    await Promise.resolve();
  });
  assert.ok(screen.getByText(/阶段 2 初版/));
  assert.equal(screen.queryByText(/已采用：先强调旧意见/), null);

  await user.click(screen.getByRole("button", { name: "按意见重生成当前阶段" }));
  assert.ok(await screen.findByText(/已采用：改用最新意见/));
  assert.equal((screen.getByLabelText("第二阶段修改意见") as HTMLTextAreaElement).value, "");
  assert.equal(
    screen.getByRole("button", { name: "确认战略并进入账号设计" }).hasAttribute("disabled"),
    false,
  );
  assert.equal(screen.queryByRole("heading", { name: "第三阶段 · 账号分层与人设包装" }), null);

  await user.click(screen.getByRole("button", { name: "确认战略并进入账号设计" }));
  assert.ok(await screen.findByRole("heading", { name: "第三阶段 · 账号分层与人设包装" }));
  await user.type(screen.getByLabelText("第三阶段修改意见"), "收紧账号谱系");
  assert.equal(
    screen.getByRole("button", { name: "确认战术并进入执行 SOP" }).hasAttribute("disabled"),
    true,
  );
  await user.click(screen.getByRole("button", { name: "按意见重生成当前阶段" }));
  assert.ok(await screen.findByText(/已采用：收紧账号谱系/));
  assert.equal((screen.getByLabelText("第三阶段修改意见") as HTMLTextAreaElement).value, "");
  assert.equal(
    screen.getByRole("button", { name: "确认战术并进入执行 SOP" }).hasAttribute("disabled"),
    false,
  );
  await user.click(screen.getByRole("button", { name: "确认战术并进入执行 SOP" }));
  assert.ok(await screen.findByRole("heading", { name: "第四阶段 · 内容裂变与起号 SOP" }));

  const runRequests = requests.filter((request) => request.action === "run");
  assert.deepEqual(runRequests.map((request) => request.stage), [2, 2, 2, 3, 3, 4]);
  assert.equal(runRequests[1].confirmed, undefined);
  assert.equal(runRequests[1].feedback, "先强调旧意见");
  assert.equal((runRequests[1].history as unknown[]).length, 0);
  assert.equal(runRequests[2].confirmed, undefined);
  assert.equal(runRequests[2].feedback, "改用最新意见");
  assert.equal(runRequests[3].confirmed, true);
  assert.equal(runRequests[3].confirmedStage, 2);
  assert.equal(runRequests[3].feedback, "");
  assert.match(
    JSON.stringify(runRequests[3].history),
    /已采用：改用最新意见/,
  );
  assert.equal(runRequests[4].confirmed, true);
  assert.equal(runRequests[4].confirmedStage, 2);
  assert.equal(runRequests[4].feedback, "收紧账号谱系");
  assert.equal((runRequests[4].history as unknown[]).length, 1);
  assert.equal(runRequests[5].confirmed, true);
  assert.equal(runRequests[5].confirmedStage, 3);
  assert.equal(runRequests[5].feedback, "");
  assert.match(
    JSON.stringify(runRequests[5].history),
    /已采用：收紧账号谱系/,
  );
});

test("reapplying the identical tested configuration preserves completed stages and download", async () => {
  const user = userEvent.setup({ document });
  const requests: Array<Record<string, unknown>> = [];
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
    const stage = Number(body.stage);
    return new Response(JSON.stringify({
      ok: true,
      action: "run",
      stage,
      markdown: `# 阶段 ${stage}\n保留结果 ${stage}`,
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  await prepareRunnableMatrix(user);
  await user.click(screen.getByRole("button", { name: "开始战略分析" }));
  await screen.findByRole("heading", { name: "第二阶段 · 战略判断" });
  await user.click(screen.getByRole("button", { name: "确认战略并进入账号设计" }));
  await screen.findByRole("heading", { name: "第三阶段 · 账号分层与人设包装" });
  await user.click(screen.getByRole("button", { name: "确认战术并进入执行 SOP" }));
  await screen.findByRole("heading", { name: "第四阶段 · 内容裂变与起号 SOP" });
  await user.click(screen.getByRole("button", { name: "确认执行方案并生成正式成品" }));
  await screen.findByRole("heading", { name: "第五阶段 · 正式矩阵方案" });
  const downloadHref = screen.getByRole("link", { name: "下载 Markdown" }).getAttribute("href");

  await user.click(screen.getByRole("button", { name: "Agent 配置" }));
  const requestCountBeforeReapply = requests.length;
  await user.click(screen.getByRole("button", { name: "应用到当前会话" }));
  assert.equal(requests.length, requestCountBeforeReapply);
  await user.click(screen.getByRole("button", { name: "Agent 对话" }));

  assert.ok(screen.getByRole("heading", { name: "第五阶段 · 正式矩阵方案" }));
  assert.match(screen.getByText(/保留结果 5/).textContent ?? "", /保留结果 5/);
  assert.equal(
    screen.getByRole("link", { name: "下载 Markdown" }).getAttribute("href"),
    downloadHref,
  );
});

test("drops a stage response that arrives after the diagnosis changes and restarts from stage 2", async () => {
  const user = userEvent.setup({ document });
  let releaseStage: (() => void) | undefined;
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.action === "test") {
      return new Response(JSON.stringify({
        ok: true,
        action: "test",
        connected: true,
        modelAvailable: true,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    await new Promise<void>((resolve) => {
      releaseStage = resolve;
    });
    return new Response(JSON.stringify({
      ok: true,
      action: "run",
      stage: 2,
      markdown: "# 不应写回的旧诊断结果",
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  await prepareRunnableMatrix(user);
  await user.click(screen.getByRole("button", { name: "开始战略分析" }));
  assert.ok(screen.getByRole("button", { name: "正在生成战略分析…" }));

  await user.clear(screen.getByLabelText("产品/服务描述"));
  await user.type(screen.getByLabelText("产品/服务描述"), "已经更新的业务描述");
  assert.ok(releaseStage);
  await act(async () => {
    releaseStage?.();
    await Promise.resolve();
  });
  assert.equal(screen.queryByText(/不应写回的旧诊断结果/), null);
  assert.equal(screen.queryByRole("heading", { name: "第二阶段 · 战略判断" }), null);

  await user.click(screen.getByRole("button", { name: "提交诊断" }));
  assert.ok(screen.getByRole("button", { name: "开始战略分析" }));
});

test("drops a stage response that arrives after the current-session configuration is cleared", async () => {
  const user = userEvent.setup({ document });
  let releaseStage: (() => void) | undefined;
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.action === "test") {
      return new Response(JSON.stringify({
        ok: true,
        action: "test",
        connected: true,
        modelAvailable: true,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    await new Promise<void>((resolve) => {
      releaseStage = resolve;
    });
    return new Response(JSON.stringify({
      ok: true,
      action: "run",
      stage: 2,
      markdown: "# 不应写回的清空前结果",
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  await prepareRunnableMatrix(user);
  await user.click(screen.getByRole("button", { name: "开始战略分析" }));
  await user.click(screen.getByRole("button", { name: "Agent 配置" }));
  await user.click(screen.getByRole("button", { name: "清空当前会话配置" }));
  assert.ok(releaseStage);
  await act(async () => {
    releaseStage?.();
    await Promise.resolve();
  });
  await user.click(screen.getByRole("button", { name: "Agent 对话" }));

  assert.equal(screen.queryByText(/不应写回的清空前结果/), null);
  assert.equal(screen.queryByRole("heading", { name: "第二阶段 · 战略判断" }), null);
  assert.match(screen.getByRole("status", { name: "内容矩阵模型状态" }).textContent ?? "", /尚未配置/);
});

test("drops an old stage response and clears prior stages when a newly tested configuration is applied", async () => {
  const user = userEvent.setup({ document });
  let releaseStage: (() => void) | undefined;
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.action === "test") {
      return new Response(JSON.stringify({
        ok: true,
        action: "test",
        connected: true,
        modelAvailable: true,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    await new Promise<void>((resolve) => {
      releaseStage = resolve;
    });
    return new Response(JSON.stringify({
      ok: true,
      action: "run",
      stage: 2,
      markdown: "# 不应写回的旧供应商结果",
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  await prepareRunnableMatrix(user);
  await user.click(screen.getByRole("button", { name: "开始战略分析" }));
  await user.click(screen.getByRole("button", { name: "Agent 配置" }));
  await user.clear(screen.getByLabelText("API Key"));
  await user.type(screen.getByLabelText("API Key"), "sk-new-session");
  await user.clear(screen.getByLabelText("模型名称"));
  await user.type(screen.getByLabelText("模型名称"), "gpt-new-session");
  await user.click(screen.getByRole("button", { name: "测试连接" }));
  await screen.findByText("连接测试成功，模型可用");
  await user.click(screen.getByRole("button", { name: "应用到当前会话" }));

  assert.ok(releaseStage);
  await act(async () => {
    releaseStage?.();
    await Promise.resolve();
  });
  await user.click(screen.getByRole("button", { name: "Agent 对话" }));
  assert.equal(screen.queryByText(/不应写回的旧供应商结果/), null);
  assert.equal(screen.queryByRole("heading", { name: "第二阶段 · 战略判断" }), null);
  assert.match(screen.getByRole("status", { name: "内容矩阵模型状态" }).textContent ?? "", /gpt-new-session/);
  assert.ok(screen.getByRole("button", { name: "开始战略分析" }));
});

test("does not create a download when stage 5 is rejected and offers a safe retry", async () => {
  const user = userEvent.setup({ document });
  let stage5Attempts = 0;
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.action === "test") {
      return new Response(JSON.stringify({
        ok: true,
        action: "test",
        connected: true,
        modelAvailable: true,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (body.stage === 5 && stage5Attempts++ === 0) {
      return new Response(JSON.stringify({
        ok: false,
        error: {
          code: "PROVIDER_UNAVAILABLE",
          message: "模型服务暂时不可用，请稍后重试。",
        },
      }), { status: 502, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      ok: true,
      action: "run",
      stage: body.stage,
      markdown: `# 阶段 ${body.stage} 安全结果`,
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  await prepareRunnableMatrix(user);
  await user.click(screen.getByRole("button", { name: "开始战略分析" }));
  await screen.findByRole("heading", { name: "第二阶段 · 战略判断" });
  await user.click(screen.getByRole("button", { name: "确认战略并进入账号设计" }));
  await screen.findByRole("heading", { name: "第三阶段 · 账号分层与人设包装" });
  await user.click(screen.getByRole("button", { name: "确认战术并进入执行 SOP" }));
  await screen.findByRole("heading", { name: "第四阶段 · 内容裂变与起号 SOP" });
  await user.click(screen.getByRole("button", { name: "确认执行方案并生成正式成品" }));

  assert.match(await screen.findByRole("alert").then((node) => node.textContent ?? ""), /暂时不可用/);
  assert.equal(screen.queryByRole("heading", { name: "第五阶段 · 正式矩阵方案" }), null);
  assert.equal(screen.queryByRole("link", { name: "下载 Markdown" }), null);
  await user.click(screen.getByRole("button", { name: "重试正式成品" }));
  assert.ok(await screen.findByRole("heading", { name: "第五阶段 · 正式矩阵方案" }));
  assert.ok(screen.getByRole("link", { name: "下载 Markdown" }));
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
  await user.click(screen.getByRole("button", { name: "确认战略并进入账号设计" }));
  assert.match(await screen.findByRole("alert").then((node) => node.textContent ?? ""), /请求过于频繁/);
  assert.ok(screen.getByRole("heading", { name: "第二阶段 · 战略判断" }));

  await user.click(screen.getByRole("button", { name: "重试账号设计" }));
  assert.ok(await screen.findByRole("heading", { name: "第三阶段 · 账号分层与人设包装" }));
  await user.click(screen.getByRole("button", { name: "确认战术并进入执行 SOP" }));
  const runningButton = screen.getByRole("button", { name: "正在生成执行 SOP…" });
  assert.equal(runningButton.hasAttribute("disabled"), true);
  await user.click(runningButton);
  assert.equal(requests.filter((request) => request.stage === 4).length, 1);
  assert.ok(releaseStage4);
  releaseStage4?.();
  assert.ok(await screen.findByRole("heading", { name: "第四阶段 · 内容裂变与起号 SOP" }));

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
  assert.equal(runRequests[1].feedback, "");
  assert.equal(runRequests[3].feedback, "");
  assert.equal(runRequests[4].feedback, "");
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
