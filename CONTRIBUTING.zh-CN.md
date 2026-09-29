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
├── e2e/                   # Chrome for Testing 测试环境、测试页、端到端测试
├── scripts/               # 构建辅助脚本、测试预加载
└── docs/                  # 发布检查清单
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

- **Chrome Web Store 上架** —— 让用户不用手动 sideload。
- **长操作进度** —— 给慢工具加 MCP 进度通知。
- **录屏**（offscreen 文档里用 tabCapture）和截图视觉对比。
- **快照识别规则改进** —— 请在 `e2e/fixtures/` 附上能复现问题的测试页。

---

## 硬性 scope 红线

byob 在设计文档里明确列了 non-goals。以下 PR 会被礼貌关闭：

- **SaaS / 云组件**。byob 零对外网络请求，这条不变。
- **In-page UI**（浮动气泡、侧边栏、content script 注入按钮）。用户已经有 MCP 客户端 UI。
- **Sandbox 跑 LLM 代码**（`sandbox.html`）。`browser_evaluate` 已覆盖，需主动开启。
- **任何 telemetry**。零 usage 上报、零安装 ping、零 crash 上传。

有想法触到这些？先开 issue 聊。

---

## 发版

1. 在 `shared/package.json`、`packages/*/package.json`、根 `package.json`、`CHANGELOG.md` 改版本号。
2. 先跑自动化测试，再手工过一遍 [`docs/e2e-checklist.md`](docs/e2e-checklist.md) 里需要人工确认的部分。
3. `git tag vX.Y.Z` + push。
4. （以后）`npm publish` bridge + mcp-server。

---

## 测试

三层测试，都能在本地跑：

```sh
bun run typecheck
bun test                              # 单元测试：快照构建、diff、键盘、引用、页面脚本转义、schema、bridge
BYOB_E2E=1 bun test e2e               # 端到端，见下
```

端到端测试会启动 **Chrome for Testing**，加载单独构建的扩展（`packages/extension/output-e2e`），bridge 跑在独立的 `BYOB_HOME`（`~/.cache/byob-e2e/home`）下，再通过真实的 MCP 服务器像 agent 一样操作 `e2e/fixtures/` 里的测试页。全程不碰你自己的 Chrome、扩展构建产物和 `~/.byob`。首次需要：`bunx @puppeteer/browsers install chrome@stable --path ~/.cache/byob-e2e`。`BYOB_E2E_HEADED=1` 显示浏览器窗口；`BYOB_E2E_BUNDLE=1` 测试打包后的插件；`bun e2e/explore.ts '[["browser_snapshot",{}]]'` 是临时试验用的驱动脚本。

页面内脚本以源码字符串形式注入；`page-scripts.test.ts` 会检查它们能被解析、正则的反斜杠没有在模板字符串里丢失。每个行为修复都应附带一个端到端场景（和测试页）。

---

## 行为准则

友善。维护者就一个人，业余 review PR。**写清"做了什么 + 为什么"** 比甩一坨不解释的代码能更快 merge。
