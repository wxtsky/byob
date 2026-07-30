<div align="center">

<img src="assets/logo.svg" alt="byob" width="120"/>

# byob

**Bring Your Own Browser** — 让 AI 助手直接用你正在用的 Chrome。

[![License: MIT](https://img.shields.io/badge/license-MIT-22c55e.svg)](LICENSE) [![MCP](https://img.shields.io/badge/MCP-stdio-0a0a0a.svg)](https://modelcontextprotocol.io) [![Chrome MV3](https://img.shields.io/badge/Chrome-MV3-f59e0b.svg)](https://developer.chrome.com/docs/extensions/mv3/intro/) [![v0.4](https://img.shields.io/badge/v0.4-ready-22c55e.svg)](CHANGELOG.zh-CN.md)

[English](README.md) · **中文**

</div>

---

byob 是一个本地 MCP 服务器，让 AI 编程工具（Claude Code、Cursor、Cline、Windsurf 等）直接操作**你正在用的 Chrome** —— 你已经登录的所有网站都能直接用。

```
"看下我 Twitter 时间线，总结前 5 条"
"Google 搜 'mcp protocol spec'，点第一个结果，读出来"
"截图 example.com"
"把我 GitHub 的 session cookie 拿出来，我要 curl 用"
"打开我 Gmail 那个 tab，告诉我有几封未读"
```

|  | WebFetch | 无头 Puppeteer | **byob** |
|---|:-:|:-:|:-:|
| 看登录后的页面 | ❌ | ⚠️ 要手动复制 cookie | ✅ 本来就登录了 |
| 绕过机器人检测 | ❌ | ❌ | ✅ 真人的浏览器 |
| 配置时间 | 0 | 几小时 | **约 5 分钟** |
| 云端费用 | 免费 | 要钱 | 免费 |

---

## 安装

### 一键安装（推荐）

```sh
curl -fsSL https://raw.githubusercontent.com/wxtsky/byob/main/install.sh | bash
```

Windows 请在 Git Bash 或 MSYS2 里运行同一条命令。脚本会自动检查依赖（Node.js ≥ 20、bun、Chrome/Edge/Brave），克隆仓库，构建所有组件，并引导你完成 MCP 注册。如果没装 bun，会按当前系统调用原生安装器。

> 设置 `BYOB_INSTALL_DIR` 可修改安装目录（默认：`~/byob`）。进阶用法：可用 `BYOB_REPO`、`BYOB_REF`、`BYOB_SKIP_SETUP=1` 安装 fork、锁定 ref，或只安装依赖并跳过交互式 setup。

### 手动安装

<details>
<summary>更习惯手动操作？</summary>

需要 **Node.js ≥ 20**、**bun**、**Chrome**，以及任意支持 MCP 的 AI 工具。

```sh
git clone https://github.com/wxtsky/byob
cd byob
bun install
bun run setup
```

</details>

`bun run setup` 是一个交互式安装流程：

1. 选择输出语言（English / 中文）
2. 生成你专属的扩展密钥
3. 构建 Chrome 扩展
4. 写入配置让 Chrome 能和 byob 通信
5. 让你多选 AI 工具。Claude Code 安装内置插件（Skill + 自动启动的
   MCP），其他客户端写入各自的 MCP 配置。

脚本跑完后还有 3 步要手动操作：

### 第 2 步 —— 在 Chrome 里加载扩展

在 Chrome 里打开 `chrome://extensions`。

1. 右上角 → 打开 **开发者模式**
2. 左上角 → 点 **加载已解压的扩展程序**
3. 选终端里打印的目录，类似：
   ```
   /你的路径/byob/packages/extension/output/chrome-mv3
   ```

### 第 3 步 —— 重启 Chrome

**完全退出 Chrome**（Mac 按 `⌘Q` / Windows 关掉所有窗口），然后重新打开。

> 仅关闭标签页或单个窗口不够 —— Chrome 只在启动时读取 Native Messaging 配置。

### 第 4 步 —— Claude Code 插件 / 手动 MCP 参考

安装脚本会自动注册你选中的 AI 工具，下面这块只是参考 —— 跳过了交互或后面想加新工具时再用：

<details open>
<summary><b>Claude Code 插件（推荐）</b></summary>

```sh
claude plugin marketplace add wxtsky/byob
claude plugin install byob@byob --scope user
```

安装后在 Claude Code 中执行 `/reload-plugins`。插件自带
`/byob:control-chrome` Skill，并会自动启动打包好的 MCP；不要再重复注册
第二个 `byob` MCP。

本地开发、不安装插件时：

```sh
claude --plugin-dir /你的路径/byob/plugins/byob
```

</details>

<details>
<summary><b>Claude Code 手动 MCP 备用方案</b></summary>

```sh
claude mcp add byob -s user -- /path/to/tsx /path/to/byob-mcp.ts
```

启用 `browser_eval`：在 `-s user` 后加 `-e BYOB_ALLOW_EVAL=1`。

</details>

<details>
<summary><b>Codex CLI</b></summary>

```sh
codex mcp add byob -- /path/to/tsx /path/to/byob-mcp.ts
```

</details>

<details>
<summary><b>Cursor</b></summary>

添加到 `.cursor/mcp.json`（项目级）或 `~/.cursor/mcp.json`（全局）：

```json
{
  "mcpServers": {
    "byob": {
      "command": "/path/to/tsx",
      "args": ["/path/to/byob-mcp.ts"]
    }
  }
}
```

</details>

<details>
<summary><b>Windsurf</b></summary>

添加到 `~/.codeium/windsurf/mcp_config.json`（JSON 格式同 Cursor）：

```json
{
  "mcpServers": {
    "byob": {
      "command": "/path/to/tsx",
      "args": ["/path/to/byob-mcp.ts"]
    }
  }
}
```

</details>

<details>
<summary><b>Cline (VS Code)</b></summary>

打开 Cline 侧边栏 → MCP Servers → Configure，粘贴（JSON 格式同 Cursor）：

```json
{
  "mcpServers": {
    "byob": {
      "command": "/path/to/tsx",
      "args": ["/path/to/byob-mcp.ts"]
    }
  }
}
```

</details>

> 以上示例中的路径为简写，实际路径由安装脚本自动生成。  
> 启用 `browser_eval`：CLI 工具加 env 参数，JSON 配置加 `"env": { "BYOB_ALLOW_EVAL": "1" }`。

### 第 5 步 —— 等 setup 自动确认上线

完成第 2、3 步（加载扩展 + ⌘Q 重启 Chrome）后，**setup 会自动检测到 bridge 上线**并打印 `✓ bridge online`，安装就完成了。在 AI 工具中新开一个会话，尝试 _"用 byob ..."_。

如果你手动 Ctrl+C 退出过 setup、或想之后再查状态：

```sh
bun run doctor
```

`bun run doctor` 会在每个 ✗ 下方打印精准的修复指令（比如"⌘Q 重启 Chrome"、"扩展 ID 不一致"等）。

---

## 工具列表

| 工具 | 功能 |
|---|---|
| `browser_read` | 打开网页，滚屏读完所有文字 |
| `browser_read_markdown` | 同上，返回干净的 markdown（去掉导航和广告） |
| `browser_extract_table` | 把 `<table>` 抽成 JSON |
| `browser_get_console_logs` | 抓 console.log / warn / error |
| `browser_start_record_network` | 开始录制 HTTP + WebSocket 流量 |
| `browser_stop_record_network` | 停止录制，导出 JSON 或 HAR |
| `browser_screenshot` | 截图保存到本地 |
| `browser_download_images` | 下载页面上所有图片 |
| `browser_click` | 点按钮、链接 |
| `browser_type` | 在输入框打字（可按回车） |
| `browser_press_key` | 发一个键盘按键（Enter / Escape / F5 / ArrowDown 等） |
| `browser_hover` | 悬停在元素上，触发 tooltip / 下拉菜单 |
| `browser_select` | 选择 `<select>` 下拉框的选项 |
| `browser_scroll` | 滚到顶部 / 底部 / 某个元素 / 指定 Y 坐标 |
| `browser_get_html` | 获取元素或整页的原始 HTML |
| `browser_get_cookies` | 导出 cookie，配合 `curl` 用 |
| `browser_navigate` | 在新 tab 或已有 tab 打开 URL |
| `browser_go_back` | 浏览器历史后退一步 |
| `browser_go_forward` | 浏览器历史前进一步 |
| `browser_wait_for` | 等某个元素出现 |
| `browser_list_tabs` | 列出所有 tab |
| `browser_switch_tab` | 切到指定 tab |
| `browser_close_tab` | 按 tabId 关闭 tab |
| `browser_eval` | 在页面跑 JS（默认关闭） |
| `browser_set_cookies` | 通过 `chrome.cookies.set` 写入 cookie（支持 CHIPS）。 |
| `browser_print_pdf` | 把当前页面存成 PDF（默认 `~/.byob/pdfs/`）。 |
| `browser_get_storage` | 读取 origin 的 `localStorage` / `sessionStorage`。 |
| `browser_get_performance` | 页面 Web Vitals + navigation timing。 |
| `browser_upload_file` | 给 `<input type="file">` 上传本地文件。 |
| `browser_intercept_start` | 启动 stateful 请求拦截会话。 |
| `browser_intercept_stop` | 停止 `browser_intercept_start` 会话并返回命中统计。 |
| `browser_drag` | 从一点拖到另一点的鼠标拖拽（线性插值）。 |
| `browser_emulate_device` | 模拟手机/平板的视口 / DPR / 触摸 / UA。 |
| `browser_snapshot` | 获取紧凑的无障碍树和可复用的元素引用。 |
| `browser_new_tab` | 新建空白或预先导航的后台 tab。 |
| `browser_reload` | 刷新 tab 并等待页面加载完成。 |
| `browser_get_js_dialog` | 查看 alert / confirm / prompt，但不替用户处理。 |
| `browser_handle_js_dialog` | 明确接受或取消 JavaScript 对话框。 |
| `browser_history` | 按关键词和时间范围搜索 Chrome 历史。 |
| `browser_clipboard_read_text` | 读取系统剪贴板里的纯文本。 |
| `browser_clipboard_write_text` | 用纯文本替换系统剪贴板内容。 |

其中 17 个工具支持 `framePath` 进入嵌套 iframe（跨域也行）。

完整 schema：[`shared/src/schemas.ts`](shared/src/schemas.ts)

---

## 工作原理

```
AI 工具 → byob-mcp → byob-bridge → Chrome 扩展 → 你的 tab
         (stdio)    (Unix socket) (Native Messaging) (Chrome 调试协议)
```

全部通信在本地完成，不产生任何对外网络请求。Chrome 关闭后，所有 byob 进程自动退出。

---

## 日常命令

```sh
bun run setup      # 安装或重新安装
bun run doctor     # 检查各环节是否正常
bun run bridges    # 列出在跑的 bridge 进程
bun run logs       # 实时看日志
bun run unsetup    # 卸载
```

在 byob 仓库根目录运行。

---

## 可靠性

- **端到端取消。** `Ctrl+C` 取消信号沿 MCP → bridge → 扩展 → Chrome 全链传递，确保所有调试会话被正确断开。
- **DevTools 冲突处理。** 如果目标 tab 正在使用 DevTools，`browser_eval` 自动降级到 `chrome.scripting.executeScript`。
- **睡眠/唤醒恢复。** 笔记本合盖再打开后，byob 自动重置所有调试连接，确保下次调用从干净状态开始。

---

## 安全

- `browser_eval` **默认关闭** —— 用 `BYOB_ALLOW_EVAL=1` 开启。每次调用都记日志 + 弹通知。
- `chrome://`、`file://`、Google / MS / Apple 登录页默认屏蔽。
- **按站点的黑白名单。** 在扩展的 service worker 控制台里设置：

  ```js
  // 任何工具都不许碰这些站点
  chrome.storage.local.set({ BYOB_DENIED_DOMAINS: ['**.chase.com', 'mail.proton.me'] })
  // 或者把 agent 锁死在固定几个站点上
  chrome.storage.local.set({ BYOB_ALLOWED_DOMAINS: ['**.github.com'] })
  ```

  匹配规则：`example.com`（精确）、`*.example.com`（只匹配子域）、`**.example.com`（主域 + 子域）、`*`（全部）。deny 优先于 allow；只要 allow 列表非空就进入白名单模式。这个检查放在 byob attach 调试器的那一步，所以**所有**工具都受管——包括 `browser_click`、`browser_get_cookies` 这类只传 `tabId` 的工具。
- **凭证输入框的值会被脱敏。** 密码 / 验证码 / 银行卡 / 邮箱输入框里的内容不会发给模型，只显示 `[redacted]`。
- 每个用户有独立的扩展密钥，互不干扰。
- socket 权限 `0600`，目录 `0700`，同机其他用户无法访问。
- **零对外网络请求。** 无数据上报、无自动更新检查、无崩溃日志上传。
- Chrome 会在页面顶部显示"正在调试此浏览器"横条，这是 Chrome 的安全机制，无法关闭。

---

## 常见问题

| 现象 | 原因 | 解决 |
|---|---|---|
| `No live bridge` | Chrome 没开或扩展禁用了 | `chrome://extensions` 检查 |
| `cdp_attach_failed` | 那个 tab 开了 DevTools | 关掉 DevTools |
| `url_forbidden` | URL 在黑名单里 | 见"安全"章节 |
| `extension_not_connected` | 扩展断连 | `chrome://extensions` reload |
| 安装后所有操作都失败 | Chrome 未完全重启 | 完全退出 Chrome（`⌘Q`）后重新打开 |

运行 `bun run doctor` 可以获取详细诊断信息，定位具体哪个环节出了问题。

---

## 各平台差异

| 平台 | 自动 | 手动 |
|---|---|---|
| **macOS** | 自动注册选中的 MCP 工具 | 自己开 `chrome://extensions` 加载扩展 |
| **Windows** | 同上 + Native Messaging host 写注册表 | 同 macOS |
| **Linux** | 自动注册选中的 MCP 工具 | 同 macOS |

---

## 了解更多

- [更新日志](CHANGELOG.zh-CN.md)
- [贡献指南](CONTRIBUTING.zh-CN.md)
- [设计文档](docs/superpowers/specs/2026-04-25-byob-design.md)
- [测试清单](docs/e2e-checklist.md)

MIT 协议。byob 对浏览器权限很大 —— 只在自己的机器和账号上用。
