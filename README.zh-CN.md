<div align="center">

<img src="assets/logo.svg" alt="byob" width="120"/>

# byob

**Bring Your Own Browser** — 让 AI 助手用你正在用的 Chrome 浏览器。

[![License: MIT](https://img.shields.io/badge/license-MIT-22c55e.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-stdio-0a0a0a.svg)](https://modelcontextprotocol.io)
[![Chrome MV3](https://img.shields.io/badge/Chrome-MV3-f59e0b.svg)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![v0.2](https://img.shields.io/badge/v0.2-ready-22c55e.svg)](CHANGELOG.md)

[English](README.md) · **中文**

</div>

---

## 它能帮你做啥

你跟 Claude（或者 Cursor / Cline）说一句话，让它去网上做点事。byob 就在**你已经登录的 Chrome 里**帮你做 —— 你已经登录了 Twitter、GitHub、Gmail、公司内网，全都用得上。

几个常见的例子：

> *"用 byob 看下我的 Twitter 时间线，把前 5 条总结一下"*

byob 在你 Chrome 里开个 tab，滚屏读完，把内容给 Claude。**因为是你真实的浏览器，所以能看到你的推文 —— 不用假账号、不用复制 cookie、不会被 captcha 卡。**

> *"Google 搜 'mcp protocol spec'，点第一个结果，把页面读出来"*

byob 去 google.com → 输入关键词 → 按回车 → 等结果 → 点第一条 → 读页面。**一句话搞定。**

> *"把我的 GitHub session cookie 拿出来，我要在脚本里用 curl"*

byob 把 cookie 给你。然后 `curl https://github.com/...` 就跟你登录了一样。

> *"截图 example.com"*

byob 存个 PNG 到本地，告诉 Claude 文件在哪。（不会把 base64 塞进 Claude 上下文 —— 那会烧掉你的 token。）

> *"打开我的 Gmail tab，告诉我有几封未读"*

云端无头浏览器看不到你 Gmail 因为它没登录。byob 能 —— **因为它就是你的浏览器**。

---

## 跟 `WebFetch` / Puppeteer 比

|  | WebFetch | 无头 Puppeteer | **byob** |
|---|:-:|:-:|:-:|
| 看登录后的内容 | ❌ | ⚠️ 要手动复制 cookie | ✅ 本来就登录了 |
| 绕过"你是机器人吧？"的检查 | ❌ | ❌ | ✅ 它真的就是你的浏览器 |
| 配置时间 | 0 | 几小时 | **5 分钟** |
| 烧云端钱 | 不烧 | 烧 | 不烧 |

---

## 5 分钟装好

```sh
git clone https://github.com/wxtsky/byob
cd byob && bun install

# 一条命令搞定：生成 key、build 扩展、写 Native Messaging manifest
( cd packages/bridge && bun run dev:cli install --dev )
```

**macOS** 上这条命令会自动帮你打开 `chrome://extensions`，并且把
`claude mcp add byob …` 命令复制到剪贴板。然后：

1. 弹出来的 Chrome 窗口里：打开 **"开发者模式"** → 点 **"加载已解压的扩展程序"** → 选 `packages/extension/.output/chrome-mv3`。
2. 完全 **退出 Chrome (⌘Q)** 再打开（让它读到 bridge manifest）。
3. 终端里 **⌘V 粘贴**剪贴板里的命令（把 byob 注册进 Claude Code）。想用 `browser_eval` 的话在 `-s user` 后面加 `-e BYOB_ALLOW_EVAL=1`。
4. `( cd packages/bridge && bun run dev:cli doctor )` → 4 个 **✓** 就 OK。

开新的 Claude Code 会话，说 *"用 byob ..."*。

> Linux: 跳过第 1 步——自己打开 `chrome://extensions`（剪贴板也不会自动 copy）。剩下 2–4 一样。
>
> Windows: 跟 macOS 一样自动 open + clip 剪贴板（用 `start chrome` + `clip`）。Native Messaging host 写到注册表里而不是 manifest 目录。

---

## byob 能做的 16 件事

| 工具 | 干啥的 |
|---|---|
| 📖 `browser_read` | 打开网页，滚屏读完所有内容 |
| 📝 `browser_read_markdown` | 同上，但返回干净的 markdown（去导航、去广告） |
| 📊 `browser_extract_table` | 把页面上的 `<table>` 抽成 JSON |
| 🪵 `browser_get_console_logs` | 抓 console.log/warn/error + JS 异常 |
| 🌐 `browser_start_record_network` / `browser_stop_record_network` | 录 HTTP + WebSocket，存 JSON 或 HAR |
| 📸 `browser_screenshot` | 截图存到本地 |
| 🖼️ `browser_download_images` | 把页面上所有图片下载到本地 |
| 🖱️ `browser_click` | 点按钮、点链接 |
| ⌨️ `browser_type` | 在输入框里打字（可选按回车） |
| 🍪 `browser_get_cookies` | 把某网站的 cookie 拿出来，后面可以用 `curl` |
| 🚀 `browser_navigate` | 在新 tab 或现有 tab 打开 URL |
| ⏳ `browser_wait_for` | 等某个元素出现 |
| 🗂️ `browser_list_tabs` | 列出我所有打开的 tab |
| 🎯 `browser_switch_tab` | 切到某个 tab |
| ⚡ `browser_eval` | 在网页里跑任意 JS（默认关 —— 见安全） |

**iframe 也能进。** 9 个工具支持 `framePath: ["#outer iframe", "#inner iframe"]` 一层层走 —— 跨域 iframe（OOPIF）也行。Notion、Stripe Checkout 这种把内容塞 iframe 里的站特别有用。

完整 input/output：[`shared/src/schemas.ts`](shared/src/schemas.ts)。

---

## 怎么工作的

```
Claude Code  ─→  byob-mcp  ─→  byob-bridge  ─→  Chrome 扩展  ─→  你的 Chrome tab
```

4 跳，全在你笔记本上。什么都不会发到外面。Chrome 一关，所有进程都退 —— 不会有后台进程偷偷活着。

---

## 可靠性

- **`Ctrl+C` 真的能停下来**。v0.2 把取消信号从 mcp-client 一路串到 bridge、扩展、CDP detach。不会再出现 agent 放弃了但 Chrome 还卡着 "byob 正在调试" 的尴尬。
- **某 tab 上 DevTools 开着，`browser_eval` 还能用**。会自动 fallback 到 `chrome.scripting.executeScript`（page world），返回里 `_meta.fallbackUsed: true` 标识。
- **合盖再打开的 case**：byob 通过 alarms + idle 双检测器发现 wake，自动 abort 在跑的录制 + detach 所有 CDP session，下次调用是干净状态。

---

## 安全提醒

- 🔒 **`browser_eval`（跑 JS）默认是关的** —— Claude 都看不到这工具存在。要开就在注册 MCP 时加 `BYOB_ALLOW_EVAL=1`。开了之后每次调用都写 log + 弹 Chrome 通知。
- 🚫 **有些站默认禁** —— `chrome://`、`file://`、你的 Google/Microsoft/Apple 登录页。免得 Claude 不小心读你密码管理器或 `/etc/passwd`。
- 🔑 **你有自己的扩展 key** —— 装的时候 byob 给你生成一个独立的 key。两个人装 byob 得到两个不同的扩展 ID，不会撞。
- 📁 **文件都是私有的** —— socket 是 `0600`、目录是 `0700`。同一台机器的其他用户读不到。
- 📡 **byob 从不"打电话回家"** —— 零数据上报、零自动更新检查、零崩溃上传。任何对外网络流量都没有。
- ⚠️ **Chrome 会在 tab 顶上显示 "byob 正在调试此浏览器"** —— **关不掉**，这是 Chrome 的安全机制，不是 byob 的 bug。任何用 Chrome 调试器的工具都一样。

---

## 日常用的命令

```sh
byob install     # 装好（或者 Chrome 出问题后修一下）
byob doctor      # 看哪一环好哪一环坏
byob bridges     # 列出在跑的 bridge
byob logs [-f]   # tail 日志
byob uninstall   # 删 launcher 和 manifest
```

---

## 想了解更多

- [设计文档](docs/superpowers/specs/2026-04-25-byob-design.md) —— byob 怎么工作的，为什么这么设计
- [更新日志](CHANGELOG.zh-CN.md) —— 已经做了啥，准备做啥
- [贡献指南](CONTRIBUTING.zh-CN.md) —— 怎么发 PR
- [测试清单](docs/e2e-checklist.md) —— 每次发版要手动跑一遍的测试

<details>
<summary>出毛病了怎么办</summary>

| 报错 | 大概率是 |
|---|---|
| `No live bridge` | Chrome 没开，或者 byob 扩展被禁用了。去 `chrome://extensions` 看。 |
| `cdp_attach_failed` | 那个 tab 上 DevTools (F12) 开着。关掉就行。 |
| 正常 URL 报 `url_forbidden` | URL 在默认黑名单里（见安全章节）。用别的 tab。 |
| `extension_not_connected` | 在 `chrome://extensions` reload 一下扩展。 |
| 刚装好用不了 | 完全退出 Chrome (⌘Q) 再开。Chrome 只在启动时检查 byob bridge。 |

还是不行就跑 `byob doctor` —— 它会告诉你具体哪一步坏了。

</details>

---

MIT 协议。byob 对你的浏览器权限很大 —— 只在自己的机器和账号上用。
