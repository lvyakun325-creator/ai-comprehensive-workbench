# Task 2 报告：内容矩阵 Agent 独立 API 配置与分阶段运行 UI

## 状态

DONE

## 改动文件

- `app/components/ContentMatrixConfigPanel.tsx`
  - 新增内容矩阵专属配置页。
  - 支持 OpenAI、Anthropic、Gemini、DeepSeek 预设及自定义 HTTPS 接口。
  - 支持 OpenAI-compatible、Anthropic、Gemini 三种协议、API 地址、密码型 API Key、模型名称。
  - 连接测试成功且模型可用后才允许应用到当前会话。
  - 提供清空当前会话配置；明确 Key 仅在页面内存、刷新清空、请求经服务端代理。
  - API Key 使用非受控 password input，避免 React 将真实 Key 写成 DOM `value` 属性。
- `app/components/ContentMatrixRunner.tsx`
  - 新增诊断页模型状态和无配置直达入口。
  - 新增第二至第五阶段运行、三个修改意见与人工确认点。
  - 运行时禁用重复提交；错误后保留历史结果和意见并提供当前阶段安全重试。
  - 第五阶段仅提供正式 Markdown 与 Blob 下载。
- `app/components/AgentWorkspace.tsx`
  - API Key、草稿配置、已测试配置和已应用配置只保存在当前 `AgentWorkspace` React 内存。
  - `action: "test"` 与 `action: "run"` 均调用 `/api/agents/content-matrix`。
  - 阶段 2 不发送确认字段；阶段 3–5 发送 `confirmed: true` 与 `confirmedStage: stage - 1`。
  - 诊断、连续历史和上一阶段修改意见按接口契约提交。
  - 对接口错误与 Markdown 再做一次当前 Key 精确遮蔽，避免异常响应进入页面、历史或下载。
  - 清空配置后阻止后续调用，保留已完成的非敏感阶段结果。
- `app/globals.css`
  - 增加配置、模型状态、阶段输出、错误、确认与下载样式。
  - 延续现有紫色内容矩阵视觉语言，并为窄屏改为单列布局。
- `tests/content-matrix-ui.test.tsx`
  - 新增真实 `Home` + React Testing Library 交互测试。
  - 覆盖专属入口、全局与其他 8 个 Agent 隔离、password、预设/自定义配置、连接失败/成功、成功后应用、未配置禁跑、模型状态直达入口、阶段顺序、确认契约、意见传递、错误重试、防重复、最终下载、清空保留结果并禁跑、Key 二次遮蔽、浏览器存储零访问。
- `tests/workbench-ui.test.tsx`
  - 将原内容矩阵配置预览断言更新为专属当前会话配置行为；其他 Agent 的共享预览断言保持不变。

未修改全局 `ModelConfigPanel`、其他 8 个 Agent 的生产行为、Task 1 服务端运行核心或路由。

## RED

### 首次功能 RED

命令：

```bash
npx tsx --test tests/content-matrix-ui.test.tsx
```

观察结果：4 fail，0 pass。

- 找不到内容矩阵专属当前会话模型配置页。
- 找不到未配置模型状态和直达配置入口。
- 找不到服务商、协议、API 地址、API Key 和模型控件。
- 无法运行第二至第五阶段、确认、重试、下载或清空流程。

失败均来自 Task 2 生产行为尚不存在，不是测试语法或环境错误。

### Key 防御性遮蔽 RED

命令：

```bash
npx tsx --test --test-name-pattern="only content matrix|runs stages" tests/content-matrix-ui.test.tsx
```

观察结果：2 fail，0 pass。

- 若异常错误响应意外包含当前 Key，Key 会进入错误 DOM。
- 若异常成功响应意外包含当前 Key，Key 会进入阶段输出与下一阶段 history。

最小修复：页面在显示错误、保存 Markdown、构造后续历史及生成下载前，对当前会话 Key 做精确替换。Task 1 服务端遮蔽仍是第一道边界。

## GREEN

### 新增定向测试

```bash
npx tsx --test tests/content-matrix-ui.test.tsx
```

结果：4 pass，0 fail。

### UI 联合回归

```bash
npx tsx --test tests/content-matrix-ui.test.tsx tests/workbench-ui.test.tsx
```

结果：11 pass，0 fail。

### 全量测试

```bash
npm test
```

结果：

- vinext / Cloudflare 构建通过。
- 53 pass，0 fail。

### 静态验证

- `npm run lint`：通过，0 error，0 warning。
- `git diff --check`：通过。
- 定向搜索确认新增生产组件没有 `localStorage`、`sessionStorage` 或 `console` 调用。

## 安全与边界自查

- [x] 只有 `agent.id === "content-matrix"` 使用真实配置和运行页。
- [x] 全局模型配置与其他 8 个 Agent 继续使用原设计预览，无 API Key 输入。
- [x] Key 只存在于 `AgentWorkspace` React 状态和密码框的运行时 value property。
- [x] Key 不进入 DOM 文本/属性、错误、日志、浏览器存储、阶段输出、历史或下载。
- [x] 页面刷新、离开 Agent 项目或组件卸载后配置丢失。
- [x] 连接测试成功且模型可用后才能应用。
- [x] 诊断完整且配置已应用后才能开始。
- [x] 阶段 2–5 严格连续，阶段 3–5 携带人工确认契约。
- [x] 清空配置后保留非敏感结果并阻止继续调用。
- [x] 最终下载只使用第五阶段 Markdown，不拼入服务商、地址、模型或 Key。
- [x] 响应式单列样式、可访问 label、状态区、alert 和 disabled 状态已覆盖。

## Concerns

- 未调用真实付费供应商；UI 测试只替换同源 `/api/agents/content-matrix` 的网络边界，Task 1 已用真实核心协议测试覆盖三家供应商。
- 当前会话配置按任务要求不持久化；刷新、离开内容矩阵 Agent 或返回 Agent 列表后需要重新配置。
