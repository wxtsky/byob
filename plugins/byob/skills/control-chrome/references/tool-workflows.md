# byob tool workflows

## Page discovery and interaction

- `browser_list_tabs`: find existing tabs and their numeric `tabId`.
- `browser_snapshot`: compact accessibility tree with actionable
  `[byob:N]` references.
- `browser_read`: extracted page text, chunks, element bounds, and interactive
  references; useful for long pages and lazy content.
- `browser_click`, `browser_type`, `browser_hover`, `browser_select`,
  `browser_press_key`, `browser_drag`, `browser_scroll`: interact with the
  current rendered UI.
- `browser_wait_for`: wait for asynchronous UI state instead of guessing with
  shell sleeps.

Normal loop:

1. Snapshot.
2. Act on `byob:idx=N`.
3. Wait only when the UI is asynchronous.
4. Snapshot again and verify the result.

## Tabs and navigation

- `browser_new_tab`: create an empty or pre-navigated background tab.
- `browser_navigate`: create a background tab when `tabId` is omitted, or
  navigate the specified tab.
- `browser_reload`, `browser_switch_tab`, `browser_go_back`,
  `browser_go_forward`, `browser_close_tab`: tab navigation and lifecycle.

Keep track of which tabs the workflow created. Do not close pre-existing tabs
as cleanup.

## Dialogs

Use `browser_get_js_dialog` before `browser_handle_js_dialog`. Never infer that
a confirm or beforeunload dialog should be accepted. Pass `text` only when
accepting a prompt.

## Content and artifacts

- `browser_screenshot`: save PNG/JPEG to a local path; use `clip` for a region.
- `browser_read_markdown`: extract a readable article as Markdown.
- `browser_get_html`: inspect raw page or element HTML.
- `browser_extract_table`: return actual HTML tables as rows or objects.
- `browser_download_images`: save page images through the signed-in session.
- `browser_print_pdf`: export the rendered page to PDF.
- `browser_upload_file`: set local files on a file input.

## Debugging

- `browser_get_console_logs`: console messages and uncaught exceptions.
- `browser_start_record_network` and `browser_stop_record_network`: bounded
  network recording, optionally HAR.
- `browser_get_performance`: navigation timing and web-vital samples.
- `browser_get_storage`: local/session storage.
- `browser_intercept_start` and `browser_intercept_stop`: temporary request or
  response interception.
- `browser_emulate_device`: persistent device emulation until reset/detach.

Stop recorders and interceptors after the requested diagnostic so they do not
continue affecting the user's browser.

## Session data

- `browser_get_cookies` and `browser_set_cookies` expose authenticated session
  state. Use only when the request specifically requires cookie work.
- `browser_history` searches Chrome history with optional terms and ISO date
  bounds. Use it only for an explicit history request; byob filters protected
  URLs before returning results.
- `browser_clipboard_read_text` and `browser_clipboard_write_text` access only
  plain text. They require an allowed tab and an explicit clipboard request.
- `browser_eval` is gated and audit-logged. Prefer a purpose-built tool.

Never paste credentials, cookies, tokens, history, clipboard content, or
private storage values into source files, logs, issue trackers, or chat unless
the user explicitly needs the exact value there.
