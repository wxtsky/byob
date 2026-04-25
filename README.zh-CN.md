<div align="center">

<img src="assets/logo.svg" alt="byob" width="120"/>

# byob

**Bring Your Own Browser** — 让 AI agent 直接驱动你已经登录的真实 Chrome。

[![License: MIT](https://img.shields.io/badge/license-MIT-22c55e.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-stdio-0a0a0a.svg)](https://modelcontextprotocol.io)
[![Chrome MV3](https://img.shields.io/badge/Chrome-MV3-f59e0b.svg)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![v0.1](https://img.shields.io/badge/v0.1-ready-22c55e.svg)](CHANGELOG.md)

[English](README.md) · **中文**

</div>

---

## 它到底能干啥

> *"用 byob 读我的 Twitter 时间线，总结前 5 条"*

byob 在你**已经登录的** Chrome 里开个后台 tab，滚屏抓内容，返回渲染后的 DOM。Claude 总结。**用你的 X session，你已经过的 reCAPTCHA，不用复制粘贴 cookie。**

> *"Google 搜 'mcp protocol spec'，点第一个官方结果，把页面读出来"*

`browser_navigate` → `browser_type`（按回车）→ `browser_wait_for` → `browser_click` → `browser_read`。5 个工具自动串联。

> *"把我的 GitHub session cookie 抓出来，我要在脚本里用 curl"*

`browser_get_cookies github.com` 返回 19 条 cookies，含 `user_session`。然后 `curl` 就能打任何私有端点。

> *"截一张 https://example.com 的图"*

`browser_screenshot` 把 PNG 落到 `~/.byob/screenshots/` 返回路径。不把 base64 塞进 LLM 上下文。

> *"打开我的 Gmail tab，告诉我有几封未读"*

byob = 用**云端无头浏览器拿不到的登录态**读页面。

---

## 跟 `WebFetch` / Puppeteer 比

|  | WebFetch | 无头 Puppeteer | **byob** |
|---|:-:|:-:|:-:|
| 看登录后的内容 | ❌ | ⚠️ 手动复制 cookie | ✅ 直接复用你登录态 |
| 绕过反爬 | ❌ | ❌ | ✅ 本来就是真浏览器 |
| 配置时间 | 0 | 几小时 | **5 分钟** |
| 烧云端钱 | ✅ | ❌ | ✅ |

---

## 5 分钟跑起来

```sh
git clone https://github.com/<你>/byob ~/code/byob
cd ~/code/byob && bun install
( cd packages/bridge && bun run dev:cli install --dev )      # 自动：生成 key → build 扩展 → 写 NM manifest
# → 跟着提示在 chrome://extensions 加载 packages/extension/.output/chrome-mv3
# → 完全退出 Chrome (⌘Q) 再打开
( cd packages/bridge && bun run dev:cli doctor )             # 4 个绿 ✓ = 通
claude mcp add byob -s user -- /Users/$USER/code/byob/packages/mcp-server/node_modules/.bin/tsx /Users/$USER/code/byob/packages/mcp-server/bin/byob-mcp.ts
```

任意 Claude Code 会话里说 *"用 byob ..."*。

---

## 10 个工具

| 工具 | 用途 |
|---|---|
| 📖 `browser_read` | 自动滚屏读页，返回正文 + 带屏幕坐标的结构化 chunks |
| 📸 `browser_screenshot` | 截 PNG/JPEG 落盘，返回路径（不返 base64，省 LLM token） |
| 🖱️ `browser_click` | CDP 真鼠标事件（绕反爬，不是 DOM 合成事件） |
| ⌨️ `browser_type` | focus + 输入，可选清空 / 按回车 |
| 🍪 `browser_get_cookies` | 导某域 cookie —— 后续 `curl` 复用 |
| 🚀 `browser_navigate` | 开新 tab 或复用 tab，支持 `load`/`domcontentloaded`/`networkidle` |
| ⏳ `browser_wait_for` | MutationObserver 等元素 visible/hidden/attached/detached |
| 🗂️ `browser_list_tabs` | 列所有 tab 的 id/url/title/active |
| 🎯 `browser_switch_tab` | 激活某 tab 并把它的窗口前置 |
| ⚡ `browser_eval` | 在 tab 里跑 JS —— **需 `BYOB_ALLOW_EVAL=1` 主动开启** |

完整 schema：[`shared/src/schemas.ts`](shared/src/schemas.ts)。

---

## 背后的链路

```
Claude Code  ─stdio→  byob-mcp  ─UNIX socket→  byob-bridge  ─Native Messaging→  byob extension  ─CDP→  Chrome
```

3 个 Node 进程 + 1 个 Chrome 扩展。**全在你笔记本上。** 零对外网络调用。Chrome 一关，所有进程自动死。空闲时占用 = `0`。

---

## 安全要点

- 🔒 **`browser_eval` 默认隐藏** —— 设 `BYOB_ALLOW_EVAL=1` 才暴露；每个 tab 限速 5 次/分钟；每次调用都写审计 log + 弹 Chrome 通知
- 🚫 **URL 黑名单** —— `chrome:` / `file:` / 认证域名默认拒绝
- 🔑 **每用户独立 RSA key** —— 每个安装得到独立的扩展 ID，不会全球撞 ID
- 📁 **socket `0600`、目录 `0700`** —— bridge 强制 `umask(0o077)`
- 📡 **零对外流量** —— byob 不发 phone home、零 telemetry、零自动更新 ping
- ⚠️ **黄条 "byob 正在调试此浏览器"** 是 Chrome 故意的 —— 任何用 CDP 的工具都得忍

---

## 管理 CLI

```sh
byob install     # 一条命令: 生成 key + build + 写 manifest
byob doctor      # 诊断链路每一环
byob bridges     # 列活的 bridge 进程
byob logs [-f]   # tail ~/.byob/bridge.log
byob uninstall   # 删 launcher + manifest
```

---

## 更多

- [设计 spec](docs/superpowers/specs/2026-04-25-byob-design.md) —— 所有协议、所有 flow、所有被否决的方案
- [CHANGELOG](CHANGELOG.zh-CN.md) —— v0.1 完整 feature log + v0.2 待办
- [CONTRIBUTING](CONTRIBUTING.zh-CN.md) —— 本地起 + 仓库约定 + 欢迎 PR 的领域
- [E2E 清单](docs/e2e-checklist.md) —— 每次发版手工跑的烟测

<details>
<summary>排错</summary>

| 现象 | 解法 |
|---|---|
| `No live bridge` | Chrome 没开 / 扩展被禁用 —— `chrome://extensions` 确认 |
| `cdp_attach_failed` | 关 DevTools (F12)；byob 内部也会自动重试 3 次 |
| 真 URL 报 `url_forbidden` | URL 在默认黑名单 —— 看安全章节 |
| `extension_not_connected` | 在 `chrome://extensions` reload 扩展 |
| 全新装识别不出来 | 完全 ⌘Q Chrome 再开 —— Native Messaging manifest 只在 Chrome 启动时读 |

</details>

---

MIT License。byob 借了你 Chrome 巨大的权限，请在你自己的机器和账号上用。
