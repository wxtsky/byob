import * as readline from 'node:readline';

const IS_WIN = process.platform === 'win32';

export type Lang = 'en' | 'zh';

let lang: Lang = 'en';

export function getLang(): Lang {
  return lang;
}

export function setLang(next: Lang): void {
  lang = next;
}

export const messages = {
  langPrompt: '  Language / 语言:\n    1) English\n    2) 中文\n',
  langAsk: '  Choice / 选择 [1/2]: ',
  installDone: { en: 'byob installed', zh: 'byob 已安装' },
  installSubtitle: {
    en: '4 steps left to wire it up',
    zh: '剩 4 步即可使用',
  },
  clipboardCopied: { en: '(copied to clipboard)', zh: '（已复制到剪贴板）' },
  nextSteps: { en: 'Next steps:', zh: '接下来：' },
  step1Title: { en: 'Load the extension into Chrome', zh: '在 Chrome 中加载扩展' },
  step1Open: { en: 'Open chrome://extensions in Chrome.', zh: '在 Chrome 中打开 chrome://extensions' },
  step1Dev: { en: 'Top-right: turn ON "Developer mode"', zh: '右上角：打开「开发者模式」' },
  step1Load: { en: 'Top-left: click "Load unpacked"', zh: '左上角：点「加载已解压的扩展程序」' },
  step1Pick: { en: 'Pick the folder:', zh: '选择目录：' },
  step2Title: { en: 'Restart Chrome', zh: '重启 Chrome' },
  step2Quit: {
    en: `${IS_WIN ? 'Close every Chrome window' : 'Quit Chrome with ⌘Q'} (closing only a tab is NOT enough), then reopen.`,
    zh: `${IS_WIN ? '关掉所有 Chrome 窗口' : '⌘Q 退出 Chrome'}（只关标签页不行），然后重新打开。`,
  },
  step2Why: {
    en: 'Chrome only reads the bridge manifest at startup.',
    zh: 'Chrome 只在启动时读取 bridge 配置。',
  },
  step3Title: { en: 'Register the MCP server with your AI tool', zh: '将 MCP 服务器注册到你的 AI 工具' },
  step3Choose: {
    en: 'Which AI tools do you use? (↑↓ move, space select, enter confirm)',
    zh: '你使用哪些 AI 工具？（↑↓ 移动，空格 选择，回车 确认）',
  },
  step3Skip: { en: 'Skipped. The MCP server command is:', zh: '已跳过。MCP 服务器命令为：' },
  step3SeeReadme: { en: 'See README for configuration examples.', zh: '详见 README 的配置示例。' },
  step3NotFound: { en: 'not found on PATH. Run manually:', zh: '未找到命令，请手动执行：' },
  step3Failed: { en: 'command failed. Run manually:', zh: '命令执行失败，请手动执行：' },
  step3Registered: { en: 'registered', zh: '已注册' },
  step3Wrote: { en: 'wrote', zh: '已写入' },
  step3ParseFailed: {
    en: "couldn't parse it, so it was left unchanged. Add this entry by hand:",
    zh: '无法解析，未做改动。请手动加入这一项：',
  },
  step3Configured: { en: 'tool(s) configured. To enable browser_evaluate, set BYOB_ALLOW_EVAL=1.', zh: '个工具已配置。启用 browser_evaluate 请设置 BYOB_ALLOW_EVAL=1。' },
  step4Title: { en: 'Wait for bridge', zh: '等待 bridge 上线' },
  step4Hint: {
    en: 'After steps ① and ②, the bridge comes online automatically.',
    zh: '完成 ① 和 ② 之后，bridge 会自动上线。',
  },
  step4Waiting: { en: 'waiting for bridge', zh: '等待 bridge 中' },
  step4OldBridge: {
    en: 'An older byob bridge is still connected. Reload the byob extension in chrome://extensions (or restart the browser) so the new version runs.',
    zh: '旧版 byob bridge 还连着。去 chrome://extensions 重新加载 byob 扩展（或重启浏览器），新版本才会生效。',
  },
  step4OnlineHeadline: {
    en: "bridge online — you're all set",
    zh: 'bridge 已上线 — 全部就绪',
  },
  step4OnlineTry: { en: 'Try in your AI tool:', zh: '在 AI 工具里试一下：' },
  step4OnlineExample: {
    en: '"use byob to read example.com"',
    zh: '「用 byob 读 example.com」',
  },
  step4TimeoutHeadline: {
    en: 'timed out — bridge did not come online within 5 minutes',
    zh: '超时 — 5 分钟内 bridge 未上线',
  },
  step4CommonCauses: { en: 'Most common causes:', zh: '最常见的原因：' },
  step4Tip1: {
    en: IS_WIN
      ? 'Chrome must be fully closed (every window) before reopening'
      : 'Chrome must be fully ⌘Q-ed (closing windows is NOT enough)',
    zh: IS_WIN
      ? '必须关掉所有 Chrome 窗口再重新打开'
      : '必须 ⌘Q 完全退出 Chrome（只关窗口不够）',
  },
  step4Tip2: {
    en: 'Extension ID mismatch — the ID shown in chrome://extensions must equal "Extension" above; if not, remove that copy and load the "Built to" folder',
    zh: '扩展 ID 不一致 — chrome://extensions 里显示的 ID 必须和上面的 Extension 一致；不一致就删掉那个，重新加载上面 Built to 的目录',
  },
  step4Tip3: {
    en: 'Browser not set up — is the browser you use listed under "NM hosts" above?',
    zh: '浏览器没配置上 — 你用的浏览器在上面 NM hosts 那一行里吗？',
  },
  step4DoctorRetry: {
    en: 'Run `bun run doctor` to re-check anytime.',
    zh: '随时跑 `bun run doctor` 复查。',
  },
} as const;

export function t(key: keyof typeof messages): string {
  const val = messages[key];
  if (typeof val === 'string') return val;
  return val[lang];
}

export async function askLang(): Promise<Lang> {
  if (!process.stdin.isTTY) return 'en';
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    process.stdout.write(messages.langPrompt);
    rl.question(messages.langAsk, (answer) => {
      rl.close();
      resolve(answer.trim() === '2' ? 'zh' : 'en');
    });
  });
}
