# byob release checklist

Most behaviour is covered automatically:

```sh
bun run typecheck
bun test                         # unit tests (all packages)
BYOB_E2E=1 bun test e2e          # Chrome for Testing + extension + bridge + MCP (source)
BYOB_E2E=1 BYOB_E2E_BUNDLE=1 bun test e2e   # same, against plugins/byob/servers/byob-mcp.mjs
```

The e2e suite needs Chrome for Testing once:
`bunx @puppeteer/browsers install chrome@stable --path ~/.cache/byob-e2e`.

What only a human can check, in a real Chrome profile — each line is a
minute or less.

## Install and link

- [ ] `curl -fsSL …/install.sh | bash` (or `bun run setup`) finishes; the
      launcher `~/.byob/bridge-host.sh` points at a version-less node path
- [ ] Load unpacked `packages/extension/output/chrome-mv3`, ⌘Q-restart Chrome
- [ ] `bun run doctor` is all ✓
- [ ] Claude Code: `/plugin` shows **byob**, `/mcp` lists 25 `browser_*`
      tools (24 without `BYOB_ALLOW_EVAL=1`)
- [ ] `claude plugin validate plugins/byob --strict` passes

## Real session

- [ ] "Open my GitHub notifications and summarise them" — uses the logged-in
      session; the new tab appears in the **byob** tab group, in the
      background
- [ ] Snapshot → click → type on a site you use daily; `snapshot:true`
      returns a diff
- [ ] `browser_batch` fills and submits a real form
- [ ] `browser_screenshot {annotate:true}` labels line up on a retina display
- [ ] A cross-origin iframe (e.g. an embedded payment or video) appears in the
      snapshot and a ref inside it can be clicked

## Boundaries

- [ ] `bun run policy --deny "**.example.com"` → any tool on example.com
      returns `url_forbidden`; `--clear-deny` restores access
- [ ] `chrome://settings` and `accounts.google.com` are refused
- [ ] Without `BYOB_ALLOW_EVAL=1`, `browser_evaluate` is not listed and
      `browser_wait {fn}` is refused
- [ ] A `confirm()` is reported and stays open until `browser_dialog`
- [ ] DevTools open on the tab → `cdp_attach_failed` with a hint

## Lifecycle

- [ ] Cancel a long call (Esc in Claude Code) → the next call works
- [ ] Close the lid for a minute, reopen → the next call works
- [ ] Quit Chrome → the bridge process exits; restart → calls work again
- [ ] Two Claude Code sessions at once keep separate working tabs
- [ ] Windows: named-pipe bridge, `bun run doctor`, one real session
