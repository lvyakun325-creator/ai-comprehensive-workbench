# Task 2 修复报告：阻止陈旧的内容矩阵连接测试响应

## 状态

DONE

## Review 验证

连接测试原实现会捕获发起请求时的配置，但响应返回后无草稿版本或请求身份校验。

因此在请求未完成时：

1. 用户编辑协议、服务商预设、API 地址、API Key 或模型名称，界面会先清除旧测试状态；
2. 用户也可以清空整个当前会话配置；
3. 但旧请求的晚到成功响应仍会无条件写回旧配置对应的 `matrixTestedConfig`，覆盖“配置已修改”或“已清空”状态，并重新启用“应用到当前会话”。

Review 指出的问题与当前代码行为一致，属于真实异步竞态。

## 改动文件

- `app/components/AgentWorkspace.tsx`
  - 新增配置 revision 和连接测试 request id，均只存在于当前组件内存。
  - 编辑任意配置字段或切换服务商预设时，同时递增 revision/request id、清除旧 tested config。
  - 清空当前会话配置时，同样递增 revision/request id，使所有未完成连接测试失效。
  - 连接测试在发起时保存不可变的草稿副本、revision 和 request id。
  - 只有响应仍对应当前 revision 和最新 request id 时，才允许写入错误、成功状态或 `matrixTestedConfig`。
  - 陈旧成功、失败及异常响应统一静默丢弃，不恢复旧 Key 对应的可应用状态。
- `tests/content-matrix-ui.test.tsx`
  - 新增真实 React 测试：测试中编辑草稿后，晚到成功响应不能覆盖修改状态或启用应用。
  - 新增真实 React 测试：测试中清空配置后，晚到成功响应不能恢复成功状态或启用应用。

未修改其他 Agent、共享 `ModelConfigPanel`、内容矩阵服务端运行核心或路由。

## RED

命令：

```bash
npx tsx --test --test-name-pattern="arrives after" tests/content-matrix-ui.test.tsx
```

结果：2 fail，0 pass。

- 编辑草稿后，晚到响应把“配置已修改”覆盖为“连接测试成功，模型可用”。
- 清空配置后，晚到响应把“当前会话配置已清空”覆盖为“连接测试成功，模型可用”。

两个失败都直接证明旧请求仍能恢复旧 Key 对应的 tested config 和可应用状态。

## GREEN

同一命令修复后结果：2 pass，0 fail。

内容矩阵与既有 UI 联合测试：

```bash
npx tsx --test tests/content-matrix-ui.test.tsx tests/workbench-ui.test.tsx
```

结果：13 pass，0 fail。

## 全量验证

- `npm test`：vinext / Cloudflare 构建通过；55 pass，0 fail。
- `npm run lint`：通过，0 error，0 warning。
- `git diff --check`：通过。

## Concerns

无阻塞或新增已知风险。修复使用 revision + request id 丢弃陈旧响应；未主动中止已发出的同源代理请求，但陈旧响应无法再改变页面配置或恢复旧 Key 的可应用状态。
