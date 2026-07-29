# Task 5 — 全量回归、安全验证与分支交接报告

日期：2026-07-29
分支：`codex/multi-agent-ui`
验证范围：Tasks 1–4 的全局模型运行时、模型配置、首页真实聊天、ContentMatrix 独立链路及移动端关键类。

## 状态

**通过，未发现由 Tasks 1–4 引入的真实回归。** 未修改产品代码或测试；本报告是唯一 Task 5 新增跟踪文件。控制器 `progress.md` 原有未提交变更按要求保留且不提交。

## 安全扫描

执行：

```bash
rg -n "console\\.(log|error)|localStorage|apiKey|authorization" \
  app/components app/api/models app/lib/global-model-runtime.ts app/lib/model-credential-store.mjs
```

结论：

- 未发现模型相关的 `console.log` / `console.error`。
- 凭据只在运行时配置、受控输入和 `Authorization: Bearer` 请求头中使用；`model-credential-store.mjs` 将凭据与普通模型元数据分离。
- 三个 `/api/models/*` 路由仅返回最小 `no-store` JSON；不返回 Key、供应商原始响应或模型列表。
- 对明显 fake credential 的 live `/api/models/test-text` 请求返回安全的 `502 PROVIDER_UNAVAILABLE` 和通用中文提示，响应中不含凭据，`cache-control: no-store`。本次运行未向页面源码或开发服务日志写入 fake credential。

补充代码/测试核验：

- `TRUSTED_PROXY_HOSTNAMES` 的 server-proxy allowlist 当前仅为 `api.openai.com`；路由强制 `egressMode: "server-proxy"`。
- APINebula browser-direct 判断要求精确 HTTPS `apinebula.ai` 主机、无端口/用户名/密码/query/hash；runtime 和 UI 测试均已覆盖 lookalike、协议和端口边界。

## 全量测试与静态检查

执行：

```bash
npm test
npm run lint
git diff --check
git status --short
```

结论：

- `npm test`：通过，构建成功，201/201 tests passed。
- `npm run lint`：0 errors；保留 3 个既有 warning，均在 `tests/model-registry.test.mjs:18` 的未使用解构变量，与本任务无关。
- `git diff --check`：通过，无空白错误。
- 初始状态仅有控制器 `progress.md` 的未提交变更；本报告新增后会作为唯一 Task 5 跟踪文件提交。

补充聚焦 UI 验证：

```bash
npx tsx --test tests/model-registry-provider.test.tsx \
  tests/content-matrix-ui.test.tsx tests/workbench-ui.test.tsx
```

结论：91/91 tests passed。覆盖：

- 全局文本/生图模型设置、保存、撤销、probe race 与凭据遮罩；
- 首页聊天的已配置模型请求、真实 reply 渲染、失败安全提示、停止/重试和模型切换；
- APINebula 精确 browser-direct 请求路径，普通模型继续 server proxy；
- ContentMatrix 临时配置与 runner 独立于全局模型注册表，不访问浏览器存储；
- `@media (max-width: 720px)` 下的底部导航、聊天工具栏/模型菜单、模型设置单列布局和动态视窗关键样式。

## 预览验证

启动：

```bash
npm run dev -- --port 3105
```

端口 `3000` 未被占用；本任务在本 worktree 的 `3105` 启动隔离预览。`curl -gfsS -D ... 'http://[::1]:3105/'` 返回 `HTTP/1.1 200 OK`，服务端渲染页面包含 AI 综合工作台、模型配置入口、聊天输入和内容矩阵 Agent 卡片。

浏览器控制表面当前不可用（返回 `No browser is available`），因此没有把“手工点击浏览器预览”表述为已完成。以上 live HTTP 路由/页面源码检查与 91 项 JSDOM UI 回归测试覆盖了该环境无法执行的交互验证。开发服务由本任务启动，确认 cwd 为本 worktree；验证结束后会仅停止该进程。

## 行为核对

| 项目 | 结论 |
| --- | --- |
| ContentMatrix 独立链路 | 通过：使用独立 `/api/agents/content-matrix` 和会话配置；全局模型选择不替代其配置。 |
| APINebula direct 边界 | 通过：精确主机及固定 `/chat/completions`、`/models` 端点；lookalike/非 HTTPS/端口变体拒绝 direct。 |
| server proxy allowlist | 通过：模型 API 路由强制 server-proxy，runtime allowlist 限定 `api.openai.com`。 |
| 模型设置 | 通过：凭据遮罩、分离存储、连接状态与 revision 绑定、未连接模型不可选。 |
| 真实聊天 | 通过（测试 fixture）：已配置模型可发送并渲染 assistant reply，直连/代理按路由边界执行，错误不回显 Key。 |
| 移动端关键类 | 通过：720px media query 对底部导航、聊天、模型选择和设置布局有明确适配；对应 UI/CSS 测试通过。 |

## 变更与交接

- 产品代码/测试修改：无。
- Task 5 提交：本报告将单独提交；不包含 `progress.md`。
- 当前 integration 选择：保持 `codex/multi-agent-ui` 未合并，等待主任务选择本地合并或创建 PR。

## 顾虑与 deferred minors

1. 完整浏览器交互检查受当前浏览器控制不可用限制；已记录替代验证证据，建议集成前若浏览器恢复可补一次真实窄屏点击验收。
2. `npm run lint` 的 3 个既有 warning 未扩大修复范围。
3. 按 ledger 仅记录、不在本任务处理：`addedModelIds` 未读；`model-registry.d.mts` 缺新 pure exports；chat transcript 无 `role=log` / `aria-live`。交最终全分支审查裁决。
