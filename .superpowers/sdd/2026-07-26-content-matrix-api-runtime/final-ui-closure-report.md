# 内容矩阵最终 UI Closure 报告

## 状态

DONE（UI 范围）

## Review 核验

两项 Important 均可在原实现中复现：

1. 当前阶段填写修改意见后，“确认并进入下一阶段”仍可点击。推进请求固定发送空 feedback，因此未重生成的意见会被静默丢弃。
2. 已应用且已测试的同一套协议、地址、Key、模型仍可再次应用；原逻辑每次都无条件清空 `matrixStages`，已完成阶段及最终下载随之消失。

## 改动文件

- `app/components/ContentMatrixRunner.tsx`
  - 当前检查点存在非空修改意见时禁用确认推进。
  - 意见为空、当前阶段未运行且流程未完成时才允许确认。
- `app/components/AgentWorkspace.tsx`
  - 当前阶段按意见重生成成功后清空该阶段意见，随后才能确认推进。
  - 比较 active/tested 配置的 `protocol`、`baseUrl`、`apiKey`、`model`。
  - 重复应用完全相同的已测试配置变为无损 no-op，不使运行中的请求失效，也不清空阶段、意见、错误或最终下载。
  - 只有上述配置字段实际变化时才沿用原保守策略，清空阶段并重新开始。
- `tests/content-matrix-ui.test.tsx`
  - 覆盖“输入意见后无法确认 → 成功重生成后意见清空 → 确认可推进”。
  - 覆盖 Stage 2、Stage 3 的门禁及修订请求契约。
  - 覆盖完成 Stage 5 并产生下载后重复应用相同配置，阶段正文与下载链接仍保留且不产生额外网络请求。
  - 将原大流程测试收窄为无意见的确认/重试流程；意见流程由专项用例独立覆盖。

未修改服务端路由、运行时、其他 Agent 或共享模型配置。

## RED

命令：

```bash
npx tsx --test --test-name-pattern='regenerates|reapplying' tests/content-matrix-ui.test.tsx
```

首次结果：0 pass，2 fail。

- 待处理意见用例：确认按钮实际未禁用，断言得到 `false !== true`。
- 相同配置重复应用用例：返回 Agent 对话后找不到“第五阶段 · 正式矩阵方案”，证明阶段及下载被清空。

## GREEN

### UI Closure 定向测试

```bash
npx tsx --test --test-name-pattern='regenerates|reapplying' tests/content-matrix-ui.test.tsx
```

结果：2 pass，0 fail。

### 内容矩阵 UI 全量

```bash
npx tsx --test tests/content-matrix-ui.test.tsx
```

结果：12 pass，0 fail。

### React UI 联合回归

```bash
npx tsx --test tests/content-matrix-ui.test.tsx tests/workbench-ui.test.tsx
```

结果：19 pass，0 fail。

### 静态检查

- `npm run lint`：通过，0 error，0 warning。
- `git diff --check`：通过。

## 全量测试说明

`npm test` 的 vinext 构建通过，UI 相关测试全部通过；当前共享工作树中的并行 runtime closure 尚未完成时，67 项中 60 pass、7 fail。失败全部位于 `tests/content-matrix-route.test.mjs` 与 `tests/content-matrix-runtime.test.mjs` 的 Stage 5 服务端输出校验，和本次 UI 三个改动文件无交集。该并行范围完成后应再跑一次全量测试确认最终状态。

## 风险与边界

- “意见已应用”以成功重生成并清空 textarea 为准；失败或陈旧响应不会清空意见，因此仍无法误推进。
- 相同配置判断包含 API Key，但 Key 仅在 React 内存态比较，不写入 DOM、存储或日志。
- 配置任一关键字段变化仍清空旧阶段，避免跨供应商或跨模型混链；只有完全相同配置重复应用才保留结果。
