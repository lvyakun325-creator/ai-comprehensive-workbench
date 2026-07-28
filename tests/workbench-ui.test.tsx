import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
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

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

test("opens all nine Agent cards and keeps Agent project navigation active", async () => {
  const user = userEvent.setup({ document });
  render(<Home />);

  for (const agent of AGENT_PROJECTS) {
    await user.click(screen.getByRole("button", { name: new RegExp(agent.title) }));

    assert.ok(screen.getByRole("heading", { name: agent.title }));
    assert.match(
      screen.getByText(new RegExp(`当前位于「${agent.title}」`)).textContent ?? "",
      /只会操作本项目资料，不会修改其他 Agent 项目/,
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
    ["总控台", "今天想推进什么经营目标？"],
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
