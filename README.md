# AI 综合工作台

基于 [vinext](https://github.com/cloudflare/vinext) 的本地 AI 经营与内容工作台。

## 当前阶段

当前版本提供普通 AI 对话、全局模型设置、内容矩阵 Agent 真实生成流程，以及九个隔离 Agent 项目的工作台界面。

- 已实现：浏览器本地模型配置、真实普通对话、内容矩阵五阶段模型调用、项目导航、任务/成果界面和 Agent 模型选择。
- ContentMatrix 独立于全局模型注册表：它的 API Key 只存在当前页面内存，刷新即清空。
- 全局模型的元数据和 API Key 保存在当前浏览器的 `localStorage`。这不是硬件级加密，同源脚本可以读取；不要在不受信任的浏览器环境中保存 Key。
- 普通对话与全局模型测试中，精确 APINebula 地址由浏览器直连；当前受支持的官方 OpenAI 地址通过工作台服务端代理。
- ContentMatrix 中，OpenAI、Anthropic、Gemini、DeepSeek 仅允许通过各自已审核的官方 HTTPS 默认端口 origin 走服务端代理。精确 APINebula 和任意自定义第三方 HTTPS 地址只能由浏览器直连。
- 自定义浏览器直连要求服务商支持 CORS，API Key 会从当前浏览器直接发送给该服务商，不经过工作台服务端。
- 仍为模拟界面：其余八个 Agent 的实际执行、外部数据抓取、任务队列持久化、附件/工具/语音能力和部分成果数据。

本地预览地址默认为 `http://localhost:3000/`。

## Prerequisites

- Node.js `>=22.13.0`

## Quick Start

```bash
npm install
npm run dev
npm run build
npm run typecheck
```

This starter does not use `wrangler.jsonc`.

## Included Shape

- edit site code under `app/`
- `.openai/hosting.json` declares optional Sites D1 and R2 bindings
- `vite.config.ts` simulates declared bindings for local development
- `db/schema.ts` starts intentionally empty
- `examples/d1/` contains an optional D1 example surface
- `drizzle.config.ts` supports local migration generation when needed

## Workspace Auth Headers

OpenAI workspace sites can read the current user's email from
`oai-authenticated-user-email`.

SIWC-authenticated workspace sites may also receive
`oai-authenticated-user-full-name` when the user's SIWC profile has a non-empty
`name` claim. The full-name value is percent-encoded UTF-8 and is accompanied by
`oai-authenticated-user-full-name-encoding: percent-encoded-utf-8`.

Treat the full name as optional and fall back to email when it is absent:

```tsx
import { headers } from "next/headers";

export default async function Home() {
  const requestHeaders = await headers();
  const email = requestHeaders.get("oai-authenticated-user-email");
  const encodedFullName = requestHeaders.get("oai-authenticated-user-full-name");
  const fullName =
    encodedFullName &&
    requestHeaders.get("oai-authenticated-user-full-name-encoding") ===
      "percent-encoded-utf-8"
      ? decodeURIComponent(encodedFullName)
      : null;

  const displayName = fullName ?? email;
  // ...
}
```

## Optional Dispatch-Owned ChatGPT Sign-In

Import the ready-to-use helpers from `app/chatgpt-auth.ts` when the site needs
optional or required ChatGPT sign-in:

- Use `getChatGPTUser()` for optional signed-in UI.
- Use `requireChatGPTUser(returnTo)` for server-rendered pages that should send
  anonymous visitors through Sign in with ChatGPT.
- Use `chatGPTSignInPath(returnTo)` and `chatGPTSignOutPath(returnTo)` for
  browser links or actions.
- Pass a same-origin relative `returnTo` path for the destination after sign-in
  or sign-out. The helper validates and safely encodes it.
- Mark protected pages with `export const dynamic = "force-dynamic"` because
  they depend on per-request identity headers.

Dispatch owns `/signin-with-chatgpt`, `/signout-with-chatgpt`, `/callback`, the
OAuth cookies, and identity header injection. Do not implement app routes for
those reserved paths. Routes that do not import and call the helper remain
anonymous-compatible.

SIWC establishes identity only; it does not prove workspace membership. Use the
Sites hosting platform's access policy controls for workspace-wide restrictions,
or enforce explicit server-side membership or allowlist checks.

Use SIWC for account pages, user-specific dashboards, saved records, and write
actions tied to the current ChatGPT user. Leave public content anonymous.

## Useful Commands

- `npm run dev`: start local development
- `npm run build`: verify the vinext build output
- `npm test`: build the workbench and run domain, server-rendering, and real React interaction tests
- `npm run typecheck`: run the strict TypeScript contract check without emitting files
- `npm run db:generate`: generate Drizzle migrations after schema changes

## Learn More

- [vinext Documentation](https://github.com/cloudflare/vinext)
- [Drizzle D1 Guide](https://orm.drizzle.team/docs/get-started/d1-new)
