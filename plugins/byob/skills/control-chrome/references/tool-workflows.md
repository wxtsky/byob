# byob tool workflows

Argument patterns for the 25 `browser_*` tools. Every tool takes an optional
`tabId`; without it the call goes to the session's working tab.

## Targets

Element tools accept one of:

- `ref: "e12"` — from `browser_snapshot` / `browser_find` (preferred; works
  inside iframes, including cross-origin ones, without any extra argument)
- `selector: "#login button"` — CSS; add `framePath: ["iframe#pay"]` to reach
  into iframes
- `x`, `y` — viewport coordinates (click / hover), e.g. from a screenshot

## Seeing the page

```
browser_snapshot {}                               full outline
browser_snapshot {interactive:true}               controls only
browser_snapshot {diff:true}                      changes since the last one
browser_snapshot {ref:"e40"}                      just that subtree
browser_find {text:"Checkout"}                    refs of matching elements
browser_find {role:"link", name:"Pricing"}        by accessible role + name
browser_screenshot {annotate:true}                image with ref labels
browser_screenshot {ref:"e9"}                     one element
browser_screenshot {fullPage:true, inline:false}  saved file only
```

## Acting

```
browser_click {ref:"e7"}                          also: doubleClick, button:"right", modifiers
browser_click {ref:"e7", snapshot:true}           + page diff in the result
browser_type {ref:"e3", text:"hello"}             replaces content (clear:false appends)
browser_type {ref:"e3", text:"lon", slowly:true}  per-key events for autocompletes
browser_type {text:"query", submit:true}          into the focused field, then Enter
browser_press_key {key:"Escape"}                  combos: "Shift+Tab", "ControlOrMeta+A"
browser_select {ref:"e5", values:["Blue"]}        native <select>, by value or label
browser_hover {ref:"e8"}                          open menus / tooltips
browser_scroll {direction:"down"}                 page; with ref/selector: that container
browser_scroll {ref:"e30"}                        scroll it into view
browser_drag {from:{ref:"e1"}, to:{ref:"e2"}}     HTML5 drag-and-drop or sliders
browser_upload_file {selector:"input[type=file]", paths:["/abs/file.pdf"]}
browser_find {label:"Email", action:"fill", value:"a@b.c"}
browser_find {label:"I agree", action:"check"}    no-op if already checked
```

### Forms in one call

```
browser_batch {steps:[
  {tool:"type",   args:{ref:"e3", text:"Ada"}},
  {tool:"type",   args:{ref:"e4", text:"ada@example.com"}},
  {tool:"select", args:{ref:"e6", values:["Pro"]}},
  {tool:"click",  args:{ref:"e9"}},
  {tool:"wait",   args:{text:"Thanks"}}
], snapshot:true}
```

## Tabs and navigation

```
browser_navigate {url:"github.com/notifications"}  background tab, reused later
browser_navigate {url:"…", newTab:true}
browser_navigate {action:"back"}                   also forward, reload
browser_tabs {}                                    list (▶ = working tab)
browser_tabs {action:"select", tabId:123}          work in that tab
browser_tabs {action:"select", tabId:123, focus:true}  and show it to the user
browser_tabs {action:"close", tabId:123}
browser_tabs {action:"history", query:"invoice"}   only when asked
```

## Reading

```
browser_read {format:"markdown"}                  main article
browser_read {outline:true}                       headings, to plan
browser_read {filter:"pricing"}                   only matching sections
browser_read {format:"links"}  /  {format:"tables"}  /  {format:"html", selector:"main"}
browser_read {url:"https://…", format:"markdown"} open + read
browser_read {scroll:true}                        trigger lazy loading first
```

## Waiting

```
browser_wait {text:"Saved"}                       also textGone
browser_wait {selector:".toast", state:"hidden"}
browser_wait {url:"*/checkout/done*"}
browser_wait {load:"networkidle", timeoutSec:15}
```

## Dialogs

An action that opens `alert/confirm/prompt` returns immediately with
`→ confirm dialog is open: "…"`. Decide from the user's intent, then
`browser_dialog {action:"accept"}` or `{action:"dismiss"}` (`promptText` for
prompts). Never accept a destructive confirmation without authorization.

## Debugging

```
browser_console {}                     since:N for only newer entries, level:"error"
browser_network {action:"record"}      → act → {action:"stop", id, format:"summary"|"json"|"har"}
browser_network {action:"intercept", rules:[{urlPattern:"*/api/*", action:"fulfill", fulfill:{status:200, body:"{}"}}]}
browser_network {action:"unintercept", id}
browser_inspect {selector:".btn", styles:["color","display"]}
browser_inspect {action:"performance"}
browser_emulate {device:"iphone-17"}   {colorScheme:"dark"}  {offline:true}  {reset:true}
browser_storage {kind:"cookies"}       {kind:"local"}  {kind:"cookies", action:"set", cookies:[…]}
browser_evaluate {expression:"document.title"}   only if exposed (BYOB_ALLOW_EVAL=1)
```

Stop recorders and interceptors after the diagnostic so they don't keep
affecting the user's browser; `browser_emulate {reset:true}` when done.

## Session data

Cookies, storage, history and clipboard expose the user's private state. Use
them only when the request needs that exact data, and never paste
credentials, tokens or private values into files, logs, issues or chat unless
the user explicitly wants them there.
