# byob v0.1 e2e Checklist

Run before tagging a release. Each line is one minute or less.

## Link

- [ ] `bun --cwd packages/bridge run dev:cli install --dev` succeeds
- [ ] `byob doctor` all green after extension reload + Chrome restart
- [ ] `curl --unix-socket ~/.byob/bridges/<id>.sock http://x/status` → `{"connected":true}`
- [ ] Kill bridge → confirm extension auto-reconnects within ~3s (extension's exponential backoff)

## Tools (all 10)

- [ ] `browser_read https://news.ycombinator.com` returns story headlines
- [ ] `browser_read https://x.com/anthropic` returns logged-in tweets (cookie reuse proof)
- [ ] `browser_screenshot https://github.com` writes file to `~/.byob/screenshots/<ts>.png`
- [ ] `browser_click textarea[name=q]` on Google home (after navigate)
- [ ] `browser_type "mcp protocol" pressEnter:true` on Google
- [ ] `browser_get_cookies github.com` returns `user_session` (or your authenticated cookie)
- [ ] `browser_navigate` between two domains, reuses tab
- [ ] `browser_wait_for #search` after a Google query → `{found:true, elapsedMs}`
- [ ] `browser_list_tabs` returns all open tabs
- [ ] `browser_switch_tab <id>` activates a chosen tab (window comes to foreground)
- [ ] `BYOB_ALLOW_EVAL=1 browser_eval document.title` returns title + emits notification + audit log line

## Errors

- [ ] `browser_read file:///etc/passwd` → `url_forbidden` envelope
- [ ] DevTools open on tab → `browser_click` returns `cdp_attach_failed` with hint
- [ ] `BYOB_ALLOW_EVAL` unset → `browser_eval` not in `tools/list` (LLM doesn't see it)
- [ ] Tab closed mid-op → `tab_closed` (or graceful failure — depends on which step)
- [ ] Chrome quit mid-call → `bridge_not_running`

## MCP clients

- [ ] Claude Code: `"use byob to ..."` triggers correct tool calls
- [ ] Cursor: same (config in Cursor settings)
- [ ] Cancel mid-call (Ctrl+C) → eventually frees the bridge slot (Phase 6 will do this cleanly)

## Polish

- [ ] `byob bridges` lists 1 process per active Chrome profile
- [ ] `byob logs -f` streams new entries
- [ ] `byob uninstall` removes launcher + all manifests; subsequent `byob doctor` shows `✗`
- [ ] Re-`byob install --dev` → all green again
