# 给 byob 贡献代码

[English](CONTRIBUTING.md) · **中文**

---

谢谢你考虑贡献。byob 是个紧凑的项目 —— 每个包就几百行代码，动手前可以从头读到尾。

---

## 项目布局

```
byob/
├── shared/                # @byob/shared — Zod schemas + command 名常量
├── packages/
│   ├── extension/         # @byob/extension — MV3 扩展，WXT 构建
│   ├── bridge/            # @byob/bridge — Native Messaging host + 管理 CLI
│   └── mcp-server/        # @byob/mcp-server — stdio MCP server
├── assets/                # logo SVG（用 scripts/build-icons.ts 转 PNG）
├── scripts/               # 构建辅助脚本
└── docs/                  # 设计文档 + 实施计划
```

`shared/` 是唯一真源 —— 任何跨进程的 schema 都在这。改协议时先改它，再向三方传播。

---

## 本地开发环境

前置依赖见主 [README](README.zh-CN.md)（Node.js >= 20、bun、Chrome）。

```sh
git clone https://github.com/wxtsky/byob
cd byob
bun install
bun run setup       # 生成 key、build 扩展、写配置
# 跟着屏幕提示在 Chrome 里加载扩展
bun run doctor      # 4 个 ✓ = 可以开干
```

`--dev` 让 bridge 通过 `tsx` 跑源码，改 `packages/bridge/src/**` 不用 build —— 扩展下次重连就吃到新代码。

改扩展代码要 rebuild 后 reload：

```sh
( cd packages/extension && bun run build )   # 然后 chrome://extensions → reload
```

---

## 仓库约定

- **Bash 前缀**：`unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY;` —— 没代理也无害，有代理就关键（贴合维护者环境）。
- **bun quirk**：`bun --cwd <绝对路径> run <脚本>` 会吞 `<脚本>` 参数（bun 1.3.x）。改用 `cd ... && bun run ...` 或直接调 `tsx`。
- **mcp-server 里禁止 `console.log`**。stdout 是 MCP 协议通道，往里写任何东西都会破坏协议。诊断用 `console.error`。
- **Handler 不能返回顶级 `type` 或 `requestId` key**。dispatcher 会用 NM 协议的 envelope（`type:'result'`、`requestId`）覆盖。（`EvalOutput.type` 撞过这事 —— 见 commit `c0bde5d`。）
- **TypeScript strict** + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`。不放松。
- **Commit 风格**：conventional 前缀（`feat(extension):`、`fix(bridge):`、`docs:`、`chore:`）。一行 summary + 写 *为什么*，不只写 *做了什么*。`Co-Authored-By:` 欢迎。
- **每个 commit 保持 working tree 全绿**。`bun run typecheck` 必须过。

---

## 欢迎什么样的 PR

目前的空跑道：

- **新工具** —— `browser_set_cookies`、`browser_press_key`、`browser_scroll`、`browser_select`、`browser_get_html`、`browser_get_text`、`browser_print_pdf` 等。
- **长操作流式进度** —— MCP `setStatus` 给慢工具加进度条。
- **Chrome Web Store 上架** —— 让用户不用手动 sideload。
- **session-handle 增量 chunk 收集** —— `browser_read` 中断后可恢复。
- **containerTree 结构化输出** —— `browser_read` 的 DOM 级别替代输出。

---

## 硬性 scope 红线

byob 在设计文档里明确列了 non-goals。以下 PR 会被礼貌关闭：

- **SaaS / 云组件**。byob 零对外网络请求，这条不变。
- **In-page UI**（浮动气泡、侧边栏、content script 注入按钮）。用户已经有 MCP 客户端 UI。
- **Sandbox 跑 LLM 代码**（`sandbox.html`）。`browser_eval` 已覆盖，需主动开启。
- **任何 telemetry**。零 usage 上报、零安装 ping、零 crash 上传。

有想法触到这些？先开 issue 聊。

---

## 发版

1. 在 `shared/package.json`、`packages/*/package.json`、根 `package.json`、`CHANGELOG.md` 改版本号。
2. 手工跑一遍 [`docs/e2e-checklist.md`](docs/e2e-checklist.md)。
3. `git tag vX.Y.Z` + push。
4. （以后）`npm publish` bridge + mcp-server。

---

## 测试哲学

byob 跨进程逻辑故意没单元测试 —— 大部分 bug 在协议接口处（CDP、Native Messaging、MCP），mock 会骗人。纯函数（`shared/src/*.ts`、`bridge/src/native-messaging.ts`、`bridge/src/extension-id.ts`）用 `bun test` 做精确覆盖；其余靠 e2e 清单手工验证。

发现 e2e checklist 没覆盖到的 regression？在修复 PR 里顺手把 case 加到 `docs/e2e-checklist.md`。

---

## 行为准则

友善。维护者就一个人，业余 review PR。**写清"做了什么 + 为什么"** 比甩一坨不解释的代码能更快 merge。
