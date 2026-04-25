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
├── assets/                # logo SVG (用 scripts/build-icons.ts 转 PNG)
├── scripts/               # 构建辅助脚本
└── docs/superpowers/      # 设计 spec + 实施计划
```

`shared/` 是唯一真源 —— 任何跨进程的 schema 都住在这。改协议时先改它，再向三方传播。

---

## 5 分钟本地起来

```sh
git clone https://github.com/<你>/byob ~/code/byob
cd ~/code/byob
bun install

( cd packages/bridge && bun run dev:cli install --dev )
# 跟着屏幕提示在 chrome://extensions 加载扩展
( cd packages/bridge && bun run dev:cli doctor )
# 4 个 ✓ = 可以开干
```

`byob install --dev` 让 bridge 通过 `tsx` 跑源码，所以改 `packages/bridge/src/**` 不用 build —— 扩展下次重连就吃到新代码。

改扩展代码要 rebuild 后在 `chrome://extensions` reload：

```sh
( cd packages/extension && bun run build )   # 然后 chrome://extensions → reload
```

---

## 仓库约定

- **Bash 前缀**：`unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY;` —— 没代理也无害，配了代理就关键（贴合维护者环境）。
- **bun quirk**：`bun --cwd <绝对路径> run <脚本>` 会吞 `<脚本>` 这个参数（bun 1.3.x 都有）。改用 `cd ... && bun run ...` 或者直接调 `tsx`。
- **mcp-server 里禁止 `console.log`**。stdout 是 MCP 协议通道，往那写任何东西都会污染协议。诊断信息一律 `console.error`。
- **Handler 不能返回顶级 `type` 或 `requestId` key**。dispatcher 会把 NM-protocol envelope（`type:'result'`、`requestId`）盖在 handler 返回上，handler 的 `type` 字段会被覆盖。（我们栽过：`EvalOutput.type` 跟协议层冲突过，整套 pending-request 集体卡死，看 commit `c0bde5d` 的故事。）
- **TypeScript strict** 加 `noUncheckedIndexedAccess` + `verbatimModuleSyntax`。这俩不放松。
- **Commit 风格**：conventional 类似（`feat(extension):`、`fix(bridge):`、`docs:`、`chore:`）。一行 summary + 一段写 *为什么* 而非 *做了什么*。`Co-Authored-By:` 行欢迎。
- **每个 commit 都得保持 working tree 全绿**。`bun run typecheck` 必须过。

---

## 欢迎什么样的 PR

最大的几条空跑道在 [CHANGELOG.md](CHANGELOG.md) 的 "deferred to v0.2"。特别值得做：

- **`browser_download_images` 工具** —— 滚屏触发懒加载 + 每张图通过 loopback HTTP 上传。bridge 端 screenshot 已经有这套机制，泛化一下即可。
- **取消传播** —— `bridge/src/ipc-server.ts` 的 `req.on('close')` 接到一个 `cancel` Native Messaging 帧，扩展端 `AbortController.abort()`，传到正在跑的 CDP 命令。
- **CDP → chrome.scripting fallback** 在 `browser_read` attach 失败时（如 DevTools 开着）。
- **Wake/sleep 检测** —— bridge `setInterval(..., 1000)`，gap > 5s ⇒ 发 `{type:'wake'}` 给扩展；扩展重置过期的 CDP session。
- **`browser_select_option`** 给 `<select>` 元素用（现在 `browser_click` 不能很好地驱动原生 select）。
- **跨 frame 寻址** —— schema 加 frameId，通过 `Page.getFrameTree` + executionContextId 解析。

---

## 硬性 scope 红线

byob 在设计 spec 里明确列了 non-goals。下面这些 PR 会被礼貌关闭：

- **SaaS / 云组件**。byob 自己零对外网络请求，这条不变。
- **In-page UI**（浮动气泡、侧边栏、content script 注入按钮）。用户已经有 MCP 客户端 UI 了。
- **Sandbox 跑 LLM 代码**（`sandbox.html` 那种）。`browser_eval` 已经覆盖这个，需要主动开启。
- **任何 telemetry**。零 usage 上报、零安装 ping、零 crash 上传。

如果你的想法触到了这些，先开个 issue 聊使用场景。

---

## 发版

`v0.1.0` 是 e2e checklist 全跑通后打的 tag。后续：

1. 在 `shared/package.json`、`packages/*/package.json`、`CHANGELOG.md` 改版本号。
2. 手工跑一遍 [`docs/e2e-checklist.md`](docs/e2e-checklist.md)。
3. `git tag vX.Y.Z` + push。
4. （以后）把 bridge + mcp-server `npm publish`。

---

## 测试哲学

byob 跨进程逻辑故意没单元测试 —— 大部分 bug 住在协议接口处（CDP、Native Messaging、MCP），mock 在那骗人。纯函数（`shared/src/*.ts`、`bridge/src/native-messaging.ts`、`bridge/src/extension-id.ts`）用 `bun test` 做小而精确的覆盖；其余靠 e2e 清单手工。

如果你发现 e2e checklist 没覆盖到的 regression，请在修复 PR 里同时把 case 加到 `docs/e2e-checklist.md`。

---

## 行为准则

友善。维护者就一个人，业余时间 review PR。**写清"做了什么 + 为什么"** 比一头扎进去甩个不解释的代码包能更快 merge。
