<div align="center">

<img src="assets/logo.svg" alt="byob" width="120"/>

# byob

**Bring Your Own Browser** — 让 AI 助手直接用你正在用的 Chrome。

[![License: MIT](https://img.shields.io/badge/license-MIT-22c55e.svg)](LICENSE) [![MCP](https://img.shields.io/badge/MCP-stdio-0a0a0a.svg)](https://modelcontextprotocol.io) [![Chrome MV3](https://img.shields.io/badge/Chrome-MV3-f59e0b.svg)](https://developer.chrome.com/docs/extensions/mv3/intro/) [![v0.5](https://img.shields.io/badge/v0.5-ready-22c55e.svg)](CHANGELOG.zh-CN.md)

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
"用我的信息把这个表单填完并提交"
```

|  | WebFetch | 无头 Puppeteer | **byob** |
|---|:-:|:-:|:-:|
| 看登录后的页面 | ❌ | ⚠️ 要手动复制 cookie | ✅ 本来就登录了 |
| 绕过机器人检测 | ❌ | ❌ | ✅ 真人的浏览器 |
| 配置时间 | 0 | 几小时 | **约 5 分钟** |
| 云端费用 | 免费 | 要钱 | 免费 |

跟那些通过 Chrome 远程调试端口接入的工具（DevTools MCP、agent-browser、Playwright `--cdp`）相比：byob 是扩展，**不用开调试端口，也不会每次连接都弹"允许远程调试？"**，本机其他程序也没法借这个口子接管你已登录的浏览器。

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

启用 `browser_evaluate`：在 `-s user` 后加 `-e BYOB_ALLOW_EVAL=1`。

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
> 启用 `browser_evaluate`：CLI 工具加 env 参数，JSON 配置加 `"env": { "BYOB_ALLOW_EVAL": "1" }`。

### 第 5 步 —— 等 setup 自动确认上线

完成第 2、3 步（加载扩展 + ⌘Q 重启 Chrome）后，**setup 会自动检测到 bridge 上线**并打印 `✓ bridge online`，安装就完成了。在 AI 工具中新开一个会话，尝试 _"用 byob ..."_。

如果你手动 Ctrl+C 退出过 setup、或想之后再查状态：

```sh
bun run doctor
```

`bun run doctor` 会在每个 ✗ 下方打印精准的修复指令（比如"⌘Q 重启 Chrome"、"扩展 ID 不一致"等）。

---

## 工具列表

v0.5 共 25 个工具。定位元素用快照里的**引用**（`[ref=e12]`）、CSS 选择器或坐标。

| 工具 | 作用 |
|---|---|
| `browser_snapshot` | 把页面变成带引用的无障碍大纲——可只看交互元素、只看变化、限定范围；iframe（含跨域）直接展开 |
| `browser_find` | 按角色+名字 / 文字 / label / placeholder / testId 查找，可直接点击、填写、勾选 |
| `browser_click` | 点击（真实鼠标事件），支持双击、右键、修饰键；自动等待，并报告跳转 / 新标签 / 弹窗 |
| `browser_type` | 填输入框、文本域、contenteditable（兼容 React/Vue）；可逐键输入；可回车提交 |
| `browser_press_key` | 带真实键码的按键和组合键（`Enter`、`Shift+Tab`、`ControlOrMeta+A`） |
| `browser_hover` / `browser_select` / `browser_scroll` / `browser_drag` | 悬停菜单、原生下拉、页面或容器滚动、HTML5 拖放 |
| `browser_upload_file` | 给 `<input type=file>` 上传本地文件 |
| `browser_batch` | 一次调用执行多步（整张表单填完提交） |
| `browser_wait` | 等元素状态、文字、URL、加载 / 网络空闲 |
| `browser_read` | 读内容：text / markdown（阅读模式）/ html / links / tables，支持大纲和关键词筛选 |
| `browser_screenshot` | 视口 / 整页 / 元素 / 区域截图，图片直接给模型；可标注引用；可导出 PDF |
| `browser_navigate` | 在后台标签打开网址，后退 / 前进 / 刷新 |
| `browser_tabs` | 列出 / 新建 / 切换 / 关闭标签，搜索历史 |
| `browser_console` | 控制台消息和页面报错（有缓冲） |
| `browser_network` | 录制流量（摘要 / JSON / HAR）或拦截：屏蔽 / 伪造 / 改写 |
| `browser_inspect` | 元素位置 / 状态 / 样式，Web Vitals |
| `browser_storage` | Cookie 和 local/sessionStorage 的读、写、清 |
| `browser_dialog` | 显式处理 alert / confirm / prompt |
| `browser_emulate` | 设备、深色模式、地理位置、时区、语言、离线、请求头 |
| `browser_clipboard` | 读写剪贴板文本 |
| `browser_download_images` | 下载页面图片 |
| `browser_evaluate` | 在页面里执行 JS（需 `BYOB_ALLOW_EVAL=1`） |

参数定义：[`shared/src/tools.ts`](shared/src/tools.ts)。从 0.4 升级？工具名变了，见[更新日志](CHANGELOG.zh-CN.md#050)。

---

## 工作原理

```
AI 工具 → byob-mcp → byob-bridge → Chrome 扩展 → 你的 tab
         (stdio)    (Unix socket) (Native Messaging) (Chrome 调试协议)
```

- byob 自己的页面脚本跑在**隔离环境**（isolated world）里：和页面共享 DOM、不共享 JS——页面上没有 `window.__byob*`、没有 `data-byob-*` 属性，网站既看不到也改不了。
- 引用保存在扩展内存里，绑定 Chrome 的节点 id；页面重新渲染后仍能找回，页面跳转后会明确拒绝（绝不悄悄点到别的元素）。
- 每个 MCP 会话有自己的"工作标签页"；agent 打开的标签页放进 **byob** 标签组，不抢焦点。

全部通信在本地完成，不产生任何对外网络请求。Chrome 关闭后，所有 byob 进程自动退出。

---

## 日常命令

```sh
bun run setup      # 安装或重新安装
bun run doctor     # 检查各环节是否正常
bun run bridges    # 列出在跑的 bridge 进程
bun run logs       # 实时看日志
bun run unsetup    # 卸载
bun run policy     # 查看 / 修改 byob 可以操作哪些网站（参数见"安全"）
```

在 byob 仓库根目录运行。

---

## 可靠性

- **操作自动等待。** 点击、输入前会等元素出现、可见、位置稳定、可用，并且确实在最上层；失败时说明原因（如"被 `<div#cookie-banner>` 挡住"）。
- **操作会报告后果**——页面跳转（会等加载完）、同页 URL 变化、新开标签、JS 弹窗——agent 不用反复轮询。
- **弹窗不会卡住调用。** 点了会弹 `confirm()` 的按钮，调用立即返回并带上弹窗内容。
- **端到端取消。** `Ctrl+C` 取消信号沿 MCP → bridge → 扩展 → Chrome 全链传递。
- **睡眠/唤醒恢复。** 合盖再打开后，byob 自动重置调试连接，下次调用从干净状态开始。
- **端到端测试。** 在 Chrome for Testing 上自动跑：`BYOB_E2E=1 bun test e2e`（见[贡献指南](CONTRIBUTING.zh-CN.md)）。

---

## 安全

- `browser_evaluate`（以及 `browser_wait` 的 `fn`）**默认关闭** —— 用 `BYOB_ALLOW_EVAL=1` 开启，每次调用都记审计日志。
- `chrome://`、`file://`、Google / MS / Apple 登录页默认屏蔽。
- **按站点的黑白名单**，只能由你设置，agent 改不了：

  ```sh
  bun run policy --deny "**.chase.com" "mail.proton.me"   # 永远不碰这些
  bun run policy --allow "**.github.com"                  # 或者：只允许这些
  bun run policy --clear-allow --clear-deny                # 清空
  bun run policy --allow-file on                           # 允许 file:// 网址
  ```

  匹配规则：`example.com`（精确）、`*.example.com`（只匹配子域）、`**.example.com`（主域 + 子域）、`*`（全部）。deny 优先于 allow；只要 allow 列表非空就进入白名单模式。检查放在 byob 接管标签页的那一步，所以**所有**工具都受管。
- **JS 弹窗永远不会被自动确认**；confirm 会一直开着，直到 agent 明确处理。
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
| `url_forbidden` | 被你的站点策略拦下 | `bun run policy` |
| `stale_ref` | 快照之后页面已跳转 | 重新 snapshot |
| `element_covered` | 有横幅 / 弹层挡着 | 先关掉它，或 `force:true` |
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
- [手动发布检查清单](docs/e2e-checklist.md)

MIT 协议。byob 对浏览器权限很大 —— 只在自己的机器和账号上用。
