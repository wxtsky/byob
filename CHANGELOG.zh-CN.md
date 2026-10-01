# Changelog (中文)

[English](CHANGELOG.md) · **中文**

> 完整英文版以 [CHANGELOG.md](CHANGELOG.md) 为准。中文版主要给中文圈快速浏览。

---

## [Unreleased]

### 修复

- **回到电脑前不会再打断 agent。** 以前唤醒检测把"60 秒没碰键盘鼠标"当成了系统休眠：看着 agent 干活一分钟、再动一下鼠标，所有进行中的调用都会被中止，网络录制和拦截被结束，所有标签页被断开。现在必须 60 秒的定时器真的停摆过才算休眠。
- **停止网络录制不再断开整个标签页。** 以前它会断开所有工具共用的调试连接，顺带结束录屏、让拦截规则失效、清掉设备模拟。现在网络录制和 `browser_emulate`（离线 / 请求头）共用 Network 域时会计数，停掉一个不影响其他的；`emulate {reset:true}` 也不会再停掉录制。
- **连接标签页失败不会再把它锁死。** 以前 `chrome.debugger.attach` 成功后、后续步骤失败（页面卡住、调用被取消），连接会残留且无人跟踪，之后对这个标签页的所有调用都报 `cdp_attach_failed`，只能关掉标签页。现在会先断开再重试，能回收自己残留的连接，并且同一标签页同一时间只做一次连接（以前并行调用会抢，其中一个失败）。
- **动作后的快照遵守站点策略。** 以前点击后跳到被禁止的页面（黑名单网站、登录页），`snapshot:true` 仍会把那个页面的内容返回给模型；现在只报告 `snapshot:true failed`。
- `browser_read {format:"html"}` 会把密码、卡号、验证码这类字段打码（React 会把输入值写进 `value` 属性）。
- `browser_read {url, tabId}` 导航前会先按站点策略检查这个标签页。
- `browser_navigate` 遇到"确定离开此页？"弹窗时立刻报告 `dialog_open`，不再干等到超时再说"仍在加载"。
- 执行上下文按标签页和 CDP 会话分开记录：以前在一个标签页关掉 iframe，可能让另一个标签页的 `framePath` 调用失败。
- byob 没盯着时被关掉的弹窗，不会再让所有工具一直报 `dialog_open`。
- 元素引用编号和控制台游标在扩展重启后也不会重复（编号按持久化的号段分配；过期的 `since` 会从头读并说明）。byob 重新连接标签页时，控制台消息不再重复。
- bridge 断开时，扩展会停掉没人再接收结果的调用，并释放它们占着的标签页锁。
- `browser_type` 遇到会重新格式化输入的字段（卡号、手机号掩码、自动转大写）或被 `maxlength` 截断时，算作成功并报告最终的值，不再报错后把值覆盖掉。`clear:false` 在 contenteditable 里会接在末尾输入。
- `browser_find` 的 check/uncheck 会读取 label 背后真正的复选框，并核对结果（以前是盲点一下）。`nth` 超过 `limit` 也能用。
- `browser_drag` 两端无法同时出现在屏幕上时直接拒绝，不再按旧坐标按下去（那里可能已经换成了别的元素）。
- 同一标签页上第二次 `browser_network intercept` 会被拒绝并给出已有的 id（以前两个拦截会悄悄互相破坏）。
- `browser_download_images` 结束后恢复页面的可见性状态，并跳过站点策略禁止的图片地址。
- `browser_batch` 里非动作类步骤（tabs、storage、evaluate、network 等）的输出和图片完整保留，被截掉的行会注明数量。
- Chrome 重启后（标签页 id 会被复用），MCP 服务器会忘掉之前的工作标签页，避免误把你自己的标签页导航走。
- bridge：超过 1 MiB 的请求（Chrome 发给扩展的上限）会直接拒绝，不再把连接弄断；客户端断开时会取消对应命令；`download_images` 的 `saveDir` 必须是绝对路径（`~/` 会展开）；上传中断不会留下半截文件。
- **`bridge.log` 不再记录页面内容。** 以前每条消息都记前 300 个字符，里面有页面文字、cookie 值和表单内容。现在只记消息类型、id、错误码和大小，超过 5 MB 会轮转。
- 安装：MCP 客户端的配置文件不是合法 JSON 时保持原样（以前会被替换成只剩 byob 的配置）；会等到*新的* bridge 上线，不会在旧 bridge 还在跑时就说成功；Linux 上的 Chromium、Edge 以及装在 `~/Applications` 里的浏览器也会写入配置。
- `byob policy` 按每个浏览器自己的名单合并（以前会把第一个浏览器的名单复制给所有浏览器）。
- `bun run doctor` 在中文等非英文系统下也能正常工作，会检查每个浏览器的配置（启动脚本和扩展 ID），显示 bridge 和扩展的版本，也不再建议删除扩展密钥。
- `install.sh` 在插件打包文件被重新生成过、或锁定了 tag 的情况下也能顺利升级。
- `uninstall` 会同时从 Cursor / Windsurf / Cline 的配置里删掉 byob。

### 新增

- `browser_upload_file` 可以直接对"选择文件"按钮使用：系统文件对话框会被拦截，文件交给它对应的输入框。
- `browser_find {framePath}`，以及把 `within` 设为某个 iframe 的 ref，都能在 iframe 里查找。
- `browser_scroll` 不指定目标、而页面本身不能滚动时，会滚动应用外壳里的主容器（Slack、Gmail 这类）。
- `browser_select` 支持被隐藏的原生 `<select>`（Chosen、select2 等），并拒绝选择被禁用的选项。
- 扩展和 MCP 服务器版本不一致时提示一次（常见于：插件更新了、扩展还没重新加载）。错误提示改成告诉 agent 该请用户做什么，而不是让它去跑自己跑不了的命令。
- `browser_snapshot` 因 `maxDepth` 截断内容时会说明；`browser_read {format:"links"}` 支持 `filter` 和 `maxChars`。
- CI 会检查提交的插件打包文件是否最新，以及所有版本号是否一致（`shared/src/version.ts`）。

## [0.6.0] — 2026-09-29

### 变更

- **默认工具列表变小。** agent 一开始只看到 20 个常用工具（工具定义约 1.47 万字符，原来 25 个约 2.28 万）。`browser_network`、`browser_emulate`、`browser_inspect`、`browser_clipboard`、`browser_download_images`、`browser_evaluate` 以及新的 `browser_record` 要 agent 调新工具 `browser_enable_tools {groups?}` 才出现（会发 MCP `tools/list_changed` 通知）。设 `BYOB_TOOLS=full` 则一开始列出全部 26 个（约 1.89 万）。`browser_batch` 只能跑当前列表里有的工具。另外工具 schema 去掉了 `$schema` / `additionalProperties:false` 这类样板，和工具说明重复的参数说明也删了。

- **`bun run setup` 不再从仓库目录直接跑 byob。** 它把 bridge 打包成一个文件，和插件里的 MCP 服务器一起装进 `~/.byob`（`bridge/byob-bridge.mjs`、`mcp/byob-mcp.mjs`），由 Node 运行。之后 pull、切分支、挪仓库都不会影响 Chrome 正在用的版本；想升级就再跑一次 `bun run setup`。开发者用 `bun run setup:dev` 保持老的"直接跑源码"方式，`bun run doctor` 会显示装的是哪种。

### 新增

- **`browser_record`**（扩展工具）：`start` → 操作 → `stop`，把一个标签页录成 `.webm` 视频（默认存到 `~/.byob/recordings/`，也可以给绝对路径 `savePath`），返回路径、时长和大小。画面来自 CDP 的 screencast，后台标签页没画面时自动改用截图补帧，所以后台也能录；编码在 offscreen 文档里做（canvas + MediaRecorder，并补上时长信息，视频可以拖动进度）。不用 `tabCapture`，所以不需要用户点击授权。跨页面跳转继续录；标签页关闭、调试被断开、超过 40 MB 或 10 分钟时自动干净地结束。
- **`browser_screenshot {diff:true}`**：和这个标签页的上一张截图（同一区域、同样大小）对比，在 service worker 里算出变化像素占比和最多 10 个合并后的变化框（CSS 像素），返回的图片上直接标出变化。尺寸不同（比如上次截的是元素、这次是视口）会说明原因并返回普通截图。
- GitHub Actions CI：Ubuntu 和 macOS 上跑类型检查 + 单元测试；Ubuntu 上用无头 Chrome for Testing 跑 e2e（源码版和发布包各一遍）。

### 修复

- **同一标签页上的操作不再交错。** 以前两个会话（或并行调用）操作同一个标签页，会把按键混在一起、互相抢焦点，或者在另一个调用把页面滚走时点下去。现在扩展对每个标签页一次只执行一个操作，按到达顺序排队。`browser_tabs`、`browser_console`、`browser_dialog`、`browser_clipboard`、`browser_wait` 不排队（弹窗必须随时能处理），排队中的调用可以取消。
- `bun test` 里的测试 bridge 会写真实的 `~/.byob` 注册表；现在测试预加载把 `BYOB_HOME` 指到临时目录。
- e2e 不再读 `~/.byob/extension-key.pem`（自己生成临时密钥），Native Messaging 配置也只写进自己的测试 profile。

## [0.5.0] — 2026-09-29

浏览器内核和工具面整体重做：吸收 Vercel agent-browser 的精华，同时保留 byob 的扩展架构——不开远程调试端口、不会每次连接都弹授权、用的是你已登录的真实 Chrome。

### 变更——工具面（不兼容）

40 个工具合并为 25 个，工具定义占用的上下文从约 36k 降到约 23k 字符。对照表：

| v0.4 | v0.5 |
|---|---|
| `browser_list_tabs` / `new_tab` / `switch_tab` / `close_tab` / `history` | `browser_tabs`（action） |
| `browser_navigate` / `go_back` / `go_forward` / `reload` | `browser_navigate`（action） |
| `browser_read` / `read_markdown` / `get_html` / `extract_table` | `browser_read`（format） |
| `browser_screenshot` / `print_pdf` | `browser_screenshot`（format: pdf） |
| `browser_wait_for` | `browser_wait` |
| `browser_get_console_logs` | `browser_console` |
| `browser_get_cookies` / `set_cookies` / `get_storage` | `browser_storage` |
| `browser_get_js_dialog` / `handle_js_dialog` | `browser_dialog` |
| `browser_clipboard_read_text` / `write_text` | `browser_clipboard` |
| 网络录制和拦截的 4 个工具 | `browser_network` |
| `browser_emulate_device` | `browser_emulate` |
| `browser_get_performance` | `browser_inspect`（performance） |
| `browser_eval` | `browser_evaluate` |
| `selector: "byob:idx=N"` | `ref: "eN"` |

新增：`browser_find`、`browser_batch`、`browser_inspect`。

### 新增

- **元素引用**（`[ref=e12]`）：绑定 Chrome 节点 id，多次快照保持不变、编号永不复用、页面跳转后明确拒绝、重新渲染后按角色+名字找回；iframe 内（包括跨域）直接可用。
- **操作前自动等待**：等目标出现、可见、稳定、可用并且确实在最上层；失败时报出挡住它的元素。
- **报告操作后果**：页面跳转（并等加载完）、同页 URL 变化、新标签、JS 弹窗；点击弹 `confirm()` 不再卡住。
- **快照**：借助 Chrome 自身的事件监听信息和 `cursor:pointer` 识别可点击的 div（排除事件委托容器的误判）、iframe 内联、只看交互元素、限定范围、增量对比、输出上限、凭证脱敏；操作加 `snapshot:true` 直接返回变化。
- **`browser_find`** 语义定位，可立即点击 / 填写 / 勾选；**`browser_batch`** 一次执行多步。
- **键盘**：美式布局，带真实 code / keyCode / 字符——回车能提交表单、Tab 能切焦点；支持 `ControlOrMeta` 和 macOS 编辑快捷键。
- **输入**兼容 React/Vue 受控组件和 contenteditable；逐键模式适配自动补全。
- **读取**：在页面内运行 Readability 和 DOM→Markdown，支持大纲、关键词筛选、链接、表格、清洗后的 HTML。
- **截图**按 CSS 像素分辨率、直接作为图片返回给模型；可标注引用（画在图上，不改页面）、页面没变可跳过、元素截图、PDF。
- HTML5 拖放、容器滚动并报告位置、每个标签页的控制台缓冲、深色模式 / 减少动画 / 地理位置 / 时区 / 语言 / 离线 / 请求头模拟。
- 每个会话独立的**工作标签页**；agent 开的标签页在后台打开、放进 **byob** 标签组，绝不把用户自己的标签页导航走。
- 结果输出为精简文本；过长的结果存到 `~/.byob/outputs/` 并给出路径。
- `bun run policy` 查看和修改站点黑白名单（刻意不做成 MCP 工具）。
- 基于 Chrome for Testing 的端到端测试（`BYOB_E2E=1 bun test e2e`）。

### 调整

- byob 的页面脚本全部在隔离环境运行：没有 `window.__byob*`、没有 `data-byob-*` 属性、不改原型，读页面也不再重置用户的滚动位置。
- bridge 变成通用转发；jsdom、turndown、Readability 服务移出 bridge。
- Native Messaging 启动脚本改用不带版本号的 node 路径，`brew upgrade node` 后不再失效。
- 执行上下文登记忽略其他扩展的隔离环境。

### 移除

- `notifications` 权限（新增 `tabGroups`）。

### 升级

拉取代码后运行 `bun run setup`（重新构建扩展并重写启动脚本），在 `chrome://extensions` 里重新加载扩展，再更新 Claude Code 插件（`/plugin` → byob → 更新，或重新跑 setup）。

## [0.4.1] — 2026-07-30

### 修复

- Native Messaging bridge 同时启动时，将 `EADDRINUSE` / `EEXIST`
  作为正常的单实例竞争处理，不再产生 uncaught 崩溃。
- 竞争失败的 bridge 不再误删赢家进程的 IPC socket 或 registry 记录；
  退出清理只处理当前 PID 真正拥有的资源。
- Chrome 关闭 Native Messaging stdout 后，bridge 现在以
  `stdout_closed` 正常退出，不再产生 uncaught `EPIPE`。
- 新增真实子进程回归测试，覆盖并发启动竞争和 stdout 提前关闭。

---

## [0.4.0] — 2026-07-30

### Claude Code 插件

- 仓库现在同时是一个 **Claude Code 插件 marketplace**。`byob` 插件自带
  MCP Server 和 `/byob:control-chrome` Skill，Claude Code 用户不再需要
  额外执行 `claude mcp add`；setup 重复运行时会自动 install / update。
- release build 会生成不依赖 workspace 的单文件 MCP bundle，Claude
  插件缓存可以直接启动。

### 浏览器能力对齐

- 新增 **`browser_snapshot`**：紧凑的无障碍树、`[byob:N]` 元素引用、
  语义层级、输出预算、敏感字段脱敏，并保留无文字图标按钮的可操作索引。
- 新增 tab 生命周期工具：`browser_new_tab`、`browser_reload`。
- 新增显式 JS 对话框工具：`browser_get_js_dialog`、
  `browser_handle_js_dialog`。alert / confirm / prompt / beforeunload 只记录，
  绝不会自动替用户确认。
- 新增 `browser_history`、`browser_clipboard_read_text`、
  `browser_clipboard_write_text`。
- click / double-click / hover 支持视口坐标；type 可输入当前焦点元素；
  scroll 支持 wheel gesture；screenshot 支持矩形裁剪。
- MCP 默认暴露 **40 个工具**；`browser_eval` 仍需显式设置
  `BYOB_ALLOW_EVAL=1` 才出现。

### 安全

- 新增 `BYOB_ALLOWED_DOMAINS` / `BYOB_DENIED_DOMAINS` 站点策略，覆盖 CDP
  与非 CDP 操作，也覆盖只传 `tabId` 的工具。
- 复用缓存 CDP session 前重新检查 tab 的实时 URL，避免 tab 从允许站点
  跳到拒绝站点后绕过策略。
- Service Worker 唤醒后，首条命令会等待 URL 策略加载完成，消除短暂默认
  放行窗口。
- password / OTP / 卡号 / 身份类输入字段在交互输出中统一脱敏。

### 可靠性与兼容性

- Windows IPC 改用 Named Pipe；setup 同时识别 Bun `.exe` 和 npm `.cmd`
  shim，注册失败会明确报错，卸载时也能处理被占用的 launcher。
- routes 和 MCP tools 改为共享声明式注册，减少 bridge / server 两侧拼写漂移。
- 加固 Native Messaging frame、上传大小限制、取消链路、iframe 坐标、
  CDP 清理、storage 截断和正则输入。
- 一键安装支持 fork、固定 ref、Windows Git Bash/MSYS2、原生安装 Bun，
  Claude 插件也可重复更新。

---

## [0.3.3] — 2026-04-28

### 修复

- **`browser_eval`** 错误信封现在透传 CDP `exceptionDetails`（line/col/stack），
  调用方能定位到页面侧的实际抛出点，而不是只看到泛泛的 "Page threw during eval"。
- **`browser_screenshot`** — bridge 在写用户传入的 `savePath` 前会 `mkdir -p`
  父目录，之前父目录不存在会 `ENOENT`。
- **`browser_screenshot`** — 返回的 `width`/`height` 现在跟实际生成的图片
  一致：`fullPage:false` 时返回 viewport 尺寸，`fullPage:true` 时返回完整
  滚动区域。之前一律返回 `documentElement.scrollHeight`，跟 `fullPage:false`
  生成的 PNG 对不上。
- **`browser_screenshot`** — 超出大小限制时的错误提示新增
  `browser_emulate_device` 作为备选方案（之前只提到 `fullPage:false` 和
  `format:jpeg`）。
- **URL guard** — `chrome-extension://` 默认不再被屏蔽。byob 自己就是扩展，
  CDP 也能 attach 扩展页；钱包 / 工具类扩展（Rabby、MetaMask 等）经常是
  审查目标。
- **URL guard** — `BYOB_ALLOW_FILE` / `BYOB_ALLOW_AUTH_DOMAINS` 开关真正
  接通了。Background SW 启动时从 `chrome.storage.local` 读取写入内存缓存，
  并监听 `storage.onChanged`。开启方式：byob 扩展 SW 控制台执行
  `chrome.storage.local.set({ BYOB_ALLOW_FILE: true })`。之前 `envFlag` stub
  恒返回 false，但 `url_forbidden` 提示还在让用户设环境变量（设了也没用）。

### 新增

- **`browser_emulate_device`** — 增加 4 个桌面视口 preset，调用方不再需要
  每次写完整的 `custom`：`desktop-1366`（1366×768）/ `desktop-1440`（1440×900 @2×）
  / `desktop-1080p`（1920×1080）/ `desktop-4k`（2560×1440 @2×）。`desktop`
  （无后缀）仍然是清空所有 override。

---

## [0.3.2] — 2026-04-27

### 新增 — 第 3 批：3 个复杂浏览器工具 / 4 个 MCP 工具（29 → 32）

- **`browser_intercept_start`** + **`browser_intercept_stop`** — 通过 CDP
  `Fetch` domain 实现 stateful 请求拦截。rules 数组，每条 `urlPattern`(glob)
  或 `urlRegex`，可选 `methods` 过滤，5 种 action 之一：`block` / `fulfill`
  / `modify`(改请求) / `modifyResponse` / `passthrough`。`modifyResponse`
  支持 `bodyReplace`(整体替换) 或 `bodyRegex`(正则就地替换) — 仅文本类
  Content-Type。复用 `record-network` 的 stateful lifecycle（start 返
  `interceptId`，stop 返命中统计）。
- **`browser_drag`** — 从一点拖到另一点的鼠标拖拽，`durationMs` 时间内
  `steps` 步线性插值。`from` / `to` 各接受 CSS selector 或 `{x, y}` 页面
  坐标。触发鼠标事件；HTML5 `dragstart`/`drag`/`dragend` 不触发。支持
  iframe（`framePath`）。
- **`browser_emulate_device`** — 通过 CDP `Emulation.*Override` 模拟视口/
  DPR/touch/User-Agent。预设：`iphone-17-pro-max`、`iphone-17`、`ipad-pro`、
  `pixel-9-pro`、`galaxy-s25-ultra`、`desktop`(重置)。或 `custom: { width,
  height, deviceScaleFactor, mobile, userAgent? }`。效果持续到重置或
  tab 关闭。

### 新增 — 错误码

- `intercept_not_found` — `intercept_stop` 的 interceptId 不存在或已 drained。

## [0.3.1] — 2026-04-26

### 新增 — 第 2 批：5 个中等复杂度浏览器工具（24 → 29）

- **`browser_set_cookies`** — 通过 `chrome.cookies.set` 写入 cookie（与
  `browser_get_cookies` 对称）。支持 CHIPS partition key 和小写 `sameSite` 枚举。
- **`browser_print_pdf`** — 用 CDP `Page.printToPDF`（流式 `IO.read`）把页面
  存为 PDF。默认目录 `~/.byob/pdfs/`，返回文件路径。支持 A4/Letter/Legal、
  横向、页码范围、统一边距，120 秒超时。
- **`browser_get_storage`** — 读取页面 origin 的 `localStorage` / `sessionStorage`。
  支持 iframe（`framePath`）。超 1MB 会截断（先丢 sessionStorage，再按字典序
  裁剪 localStorage keys）。
- **`browser_get_performance`** — 页面 Web Vitals（LCP/CLS/INP/FCP/TTFB）+
  navigation timing（DCL、load、DNS、TCP、传输大小）。默认 3000ms 采样窗口；
  INP 需要真实用户交互才有值。
- **`browser_upload_file`** — 通过 CDP `DOM.setFileInputFiles` 给
  `<input type="file">` 上传本机文件。Bridge 在转发前校验绝对路径 + `fs.access`。
  自动派发 `input` + `change` 事件。支持 iframe（`framePath`）。

### 新增 — 错误码

- `not_a_file_input` — `upload_file` 的 selector 不是 `<input type="file">`。
- `file_not_found` — `upload_file` 的路径缺失/不可读/非绝对。

---

## [0.3.0] — 2026-04-26

### 新增 8 个工具（16 → 24）

- **`browser_scroll`** —— 滚到页面顶部 / 底部、滚到某个 selector、或滚到指定 Y 坐标。返回最终 `scrollY` + `pageHeight`。
- **`browser_press_key`** —— 发一个键盘事件（Enter / Escape / Tab / F5 / ArrowDown 等），可选 Alt / Control / Shift / Meta 修饰键。
- **`browser_select`** —— 按 value / label / index 选 `<select>` 的 `<option>`。会派发 `input` + `change` 事件，SPA 框架能正常监听。
- **`browser_close_tab`** —— 按 tabId 关闭标签页。
- **`browser_go_back` / `browser_go_forward`** —— 在 tab 的历史栈里前进/后退一步。栈为空时返回 `no_history`。
- **`browser_hover`** —— 把鼠标移到指定元素上（走真实 CDP 鼠标事件），触发 tooltip 和 `:hover` 下拉菜单。
- **`browser_get_html`** —— 返回某个元素（或整个 document）的 outerHTML / innerHTML。按 `maxBytes`（默认 256 KB，最大 8 MB）截断，UTF-8 边界安全。

### 新增错误码

- `option_not_found` —— `<select>` 内按 value / label / index 没找到匹配的 `<option>`。
- `no_history` —— tab 的历史栈里没有可前进 / 后退的条目。

### 内部

- 8 个新增 schema 的单测：覆盖必填字段、XOR 校验、默认值。

---

## [0.2.0] — 2026-04-25

### 5 个新工具（11 → 16）

- **`browser_get_console_logs`** —— 快照某 tab 的 `console.log/warn/error` + 未捕获异常（CDP `Runtime.consoleAPICalled` + `Runtime.exceptionThrown`）。
- **`browser_read_markdown`** —— 页面 → 干净 markdown，走 Mozilla Readability + turndown。**转换在 bridge 进程里跑（jsdom）**，页面本身看不到 Readability 的 DOM。
- **`browser_extract_table`** —— `<table>` → JSON。两种输出（`rows` 原始数组 / `objects` 按表头取键），每张表还附带 `nthOfType` selector 方便后续点击。
- **`browser_start_record_network` / `browser_stop_record_network`** —— 成对的 HTTP + WebSocket 抓包。输出 JSON 或 HAR 1.2（DevTools 直接吃）。底层是 CDP `Network.*` 累加器 + URL pattern 过滤 + SW 被驱逐时的自保。

### iframe 支持（D 线）

- **9 个工具新增 `framePath: string[]` 参数** —— `browser_read / click / type / eval / wait_for / download_images / get_console_logs / read_markdown / extract_table`。每一层用 CSS selector 走嵌套 iframe。
- **跨域 iframe（OOPIF）也工作** —— 走 CDP `Target.setAutoAttach({ flatten: true })`，扩展自动跟进子 session。
- **嵌套 iframe 内点击的页面级坐标换算**（frame-coords 把每层 `getBoundingClientRect` 累加）。
- **4 个新错误码**：`frame_not_found` / `frame_navigation_during_op` / `frame_attach_failed` / `frame_eval_blocked`，每个带 `framePathIndex` + `reason` 告诉 LLM 具体哪一跳挂了。

### Cancel 全链（B.1 线）

- **端到端取消** —— mcp-client `Ctrl+C` → bridge `POST /cancel` → Native Messaging cancel 帧 → handler `AbortSignal` → CDP detach。pending 的 `bridgePost / bridgeGet` 立刻 reject 成新的 `ABORTED` 错误码，不会再等到 10 分钟超时。
- 每次调用的 `requestId` 现在贯穿所有层，每个 handler 都接 `AbortSignal`。

### CDP fallback（B.2 线）

- **`browser_eval` 在 CDP attach 失败时降级到 `chrome.scripting.executeScript`**（比如 tab 开着 DevTools）。fallback 在 page world 跑，返回同样的形状，并在 `_meta.fallbackUsed: true` 里标记，调用方能看出来。

### Wake/sleep 恢复（B.3 线）

- **双检测器** —— `chrome.alarms` 周期心跳 + `chrome.idle` 状态变化。**唤醒后**：把 in-flight 录制全 abort 掉，所有 CDP session 全 detach，下次调用是干净状态。
- 新的 `ABORTED_DUE_TO_WAKE` 错误码，跟用户主动 `Ctrl+C` 区分开。

### 内部

- **70+ 单测**：schema / frame-resolver / har-converter / url-pattern / handler abort 链路（v0.1 这块单测稀疏）。
- `browser_extract_table` 输出加了 `nthOfType` selector hint，方便后续点击对应那张表。

### 修复

- **`browser_extract_table` 隐式 thead 检测** —— 当第一行 `<tr>` 全是 `<th>` 时 Chrome 会自动包一层 `<tbody>`，之前会被当成空表，现在按表头处理。
- **bridge GET 路由接受 `?_requestId=` 查询参数** —— Cancel 全链（B.2）的回归，合并后短暂让 `browser_list_tabs` 挂了。

---

## [0.1.0] — 2026-04-25

### 旗舰功能

- **10 个 MCP 工具** 端到端跑通：`browser_read`、`browser_screenshot`、`browser_click`、`browser_type`、`browser_get_cookies`、`browser_navigate`、`browser_wait_for`、`browser_list_tabs`、`browser_switch_tab`、`browser_eval`。
- **Native Messaging 全链路** —— bun-workspaces TS monorepo，3 个包（`@byob/shared` schemas、`@byob/bridge` Native Messaging host、`@byob/mcp-server` stdio MCP server）+ WXT 构建的 MV3 扩展。
- **每用户独立 RSA key** —— `byob install` 首次跑会自动生成 `~/.byob/extension-key.pem`；`wxt.config.ts` 动态读它。两台机器装 byob 得到两个不同的扩展 ID。
- **一条命令安装** —— `byob install` 全自动：生成 key → build 扩展 → 写 NM manifest → 打印下一步。
- **多 bridge 支持** —— 每个 Chrome profile 一个 `byob-bridge` 进程，全在 `~/.byob/bridges.json` 里登记 + PID 探活。
- **管理 CLI** —— `byob doctor / install / bridges / logs / uninstall`。

### 可靠性

- **CDP attach 3 次重试** + 线性 backoff（解 DevTools 切换的 race）。
- **discarded tab 复活** —— Chrome 因内存压力 GC 了后台 tab 时，attach 前自动 reload + waitForLoad。
- **特殊 URL 预检** —— 在 CDP attach 之前抓住 `chrome://` / `devtools://` / `about://` active tab，报为 `url_forbidden` + 可操作 hint，不再是模糊的 `cdp_attach_failed`。
- **`chrome.power.requestKeepAwake('display')`** 用 refcounted helper 包裹长操作，并发调用不打架。
- **beforeunload 守卫** —— `browser_read` 期间安装，防 SPA 自发跳转把 DOM 抽走。
- **SPA priming + scrollHeight 稳定检测** —— 首屏 prime + 跟踪 scrollHeight 稳定性，修了"X.com / FB / 新版 Reddit 第 1 轮抓零 chunks"的失败。
- **bridgePost / bridgeGet timeout** —— undici Agent 显式 10 分钟上限 + bridge 不可达时干净的 `bridge_not_running` envelope。
- **NM 协议 envelope 剥离** —— bridge 不再泄漏 `type` / `requestId` 到 HTTP 响应。
- **Handler `type` 字段冲突修复** —— dispatcher 现在先 spread payload 再写 NM 协议字段，handler 永远不能 shadow `type:'result'`（`EvalOutput.type` 撞过这事，整个 pending-request map 失灵）。
- **Cookie sameSite 枚举** 现在匹配 Chrome `chrome.cookies` API 的小写格式，不再混用 CDP `Network.getCookies` 的大写。
- **focused-window tab 放置** —— 新后台 tab 出现在用户当前看的窗口里，不会冒到别的窗口去。

### 安全

- **`browser_eval` 默认隐藏**。MCP server env 里设 `BYOB_ALLOW_EVAL=1` 才暴露给 LLM。
- **URL 黑名单** —— `chrome:`/`chrome-extension:`/`about:`/`devtools:`/`view-source:`/`file:` 协议 + 主要认证域名默认拒绝。
- **eval 审计日志** —— 每次调用都 append 到 `~/.byob/eval-audit.log`。
- **eval 限速** —— 每个 tab 5 次/分钟（扩展端）。
- **eval Chrome 通知** —— 每次调用弹一条系统通知。
- **socket 文件 0600**、`~/.byob/` 目录 0700、bridge 进程强制 `umask(0o077)`。

### 标记延后到 v0.2

- 取消 / Abort 传播（MCP 客户端取消 → bridge → CDP detach）
- CDP 失败时 fallback 到 `chrome.scripting.executeScript`
- `browser_download_images` 独立工具（大 payload 走 loopback HTTP）
- Wake / sleep 检测（1s tick，gap > 5s）
- 跨 frame iframe 操作（`Page.getFrameTree` + executionContextId）
- 长操作流式进度（MCP `setStatus`）
- containerTree 结构化输出
- session-handle 增量 chunk 收集
- Chrome Web Store 上架
