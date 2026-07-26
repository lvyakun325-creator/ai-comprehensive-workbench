# 内容矩阵最终整体验收：UI 修复报告

## 状态

DONE

## Review 核验

四项 UI 反馈均与原实现行为一致：

1. 原页面把“修改意见”直接作为下一阶段请求的 feedback，点击确认会同时采用意见并推进，缺少“重生成当前阶段”的独立动作。
2. 阶段生成没有 revision/request id。运行中修改诊断、反馈、清空配置或应用新配置后，晚到响应仍可能写回旧结果。
3. 修改诊断只把 `matrixReady` 设为 false，没有清空依赖该诊断的阶段结果。
4. Stage 5 失败虽不会产生成功结果，但缺少针对“拒绝后绝不出现下载、仍可安全重试”的完整 UI 回归。

服务端现有确认契约可以直接兼容当前阶段重生成：

- 重生成 Stage 2：不带确认，history 为空。
- 重生成 Stage 3/4：带 `confirmed: true` 和 `confirmedStage: stage - 1`，history 只包含此前阶段。
- 明确确认并推进：feedback 为空，history 使用已修订的当前阶段 Markdown。

因此本次未修改服务端运行核心或路由。

## 改动文件

- `app/components/AgentWorkspace.tsx`
  - 阶段操作拆分为 `advance` 与 `regenerate`。
  - 重生成同一阶段时使用当前阶段 feedback 并替换该阶段 Markdown，不推进阶段。
  - 确认推进时不携带修改意见，使用当前已修订结果作为下一阶段 history。
  - 新增统一的 stage run revision 与 request id。
  - 修改诊断、修改反馈、清空配置、应用新配置都会使未完成阶段请求失效。
  - 陈旧成功、错误和异常响应均不能写回结果、错误或运行状态。
  - 修改任意诊断字段会清空全部依赖阶段、feedback、错误和运行状态；重新提交后从 Stage 2 开始。
  - 应用已测试的新配置时保守清空阶段结果，避免不同供应商或模型结果混链。
  - 清空配置继续保留此前已完成的非敏感结果，但阻止继续运行；未完成请求不会补写结果。
- `app/components/ContentMatrixRunner.tsx`
  - 第二至第四阶段分别显示“按意见重生成当前阶段”和“确认并进入下一阶段”。
  - 重生成按钮仅在修改意见非空时可用。
  - 重生成与推进分别显示独立运行中、错误重试状态。
  - Stage 5 拒绝后保留 Stage 4 检查点，显示安全重试，不创建下载。
- `app/globals.css`
  - 新增阶段双动作按钮的响应式布局和既有按钮状态样式复用。
- `tests/content-matrix-ui.test.tsx`
  - 新增当前阶段重生成、反馈修改使旧响应失效、修订后明确确认才推进的真实 React 回归。
  - 覆盖 Stage 2 重生成无确认，以及 Stage 3 重生成带上一阶段确认的服务端请求契约。
  - 覆盖运行中改诊断、清空配置、应用新配置后晚到响应不写回。
  - 覆盖应用新配置后阶段清空、重新从 Stage 2 开始。
  - 覆盖 Stage 5 拒绝后无标题/下载，并可安全重试成功。
  - 更新原顺序运行测试：确认推进请求 feedback 必须为空。

未修改其他 Agent、共享 `ModelConfigPanel` 或服务端文件。

## RED

### 修改意见与确认混用

命令：

```bash
npx tsx --test --test-name-pattern="regenerates" tests/content-matrix-ui.test.tsx
```

首次观察：失败。

- Stage 2 填写修改意见后，只存在“确认战略并进入账号设计”。
- 找不到“按意见重生成当前阶段”。
- 证明原 UI 无法在不推进的情况下按意见修订当前阶段。

### 阶段陈旧响应

新增真实延迟响应测试在原实现下验证：

- 修改诊断后，旧 Stage 2 结果仍会写回。
- 清空配置后，清空前的阶段结果仍会晚到写回。
- 应用新配置后，旧供应商请求仍可能写回并与新配置混链。
- 重生成过程中修改 feedback，旧 feedback 对应结果仍可能覆盖当前输出。

## GREEN

### 内容矩阵 UI 定向测试

```bash
npx tsx --test tests/content-matrix-ui.test.tsx
```

结果：11 pass，0 fail。

### UI 联合回归

```bash
npx tsx --test tests/content-matrix-ui.test.tsx tests/workbench-ui.test.tsx
```

结果：18 pass，0 fail。

## 全量验证

- `npm test`：vinext / Cloudflare 构建通过；66 pass，0 fail。
- `npm run lint`：通过，0 error，0 warning。
- `git diff --check`：通过。

全量 66 项包含并行服务端最终验收的 redirect 禁用和 Stage 5 输出契约测试；UI 与服务端最终契约联合通过。

## Concerns

- UI 使用 revision/request id 丢弃陈旧阶段响应，没有主动 Abort 已发送请求；陈旧响应无法改变页面状态或进入后续 history。
- 应用新配置会按保守策略清空已有阶段结果。清空配置仍按原 Task 2 要求保留已完成的非敏感结果，但重新应用配置时会从 Stage 2 重建，避免跨模型混链。
