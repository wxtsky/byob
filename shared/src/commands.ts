export const Command = {
  Tabs:           'tabs',
  Navigate:       'navigate',
  Snapshot:       'snapshot',
  Find:           'find',
  Read:           'read',
  Screenshot:     'screenshot',
  Console:        'console',
  Inspect:        'inspect',
  Click:          'click',
  Hover:          'hover',
  Type:           'type',
  PressKey:       'pressKey',
  Select:         'select',
  Scroll:         'scroll',
  Drag:           'drag',
  UploadFile:     'uploadFile',
  Wait:           'wait',
  Evaluate:       'evaluate',
  Storage:        'storage',
  Dialog:         'dialog',
  Clipboard:      'clipboard',
  Emulate:        'emulate',
  Network:        'network',
  DownloadImages: 'downloadImages',
} as const;

export type CommandName = (typeof Command)[keyof typeof Command];

// NM-protocol-only frame discriminators (not handler commands; not exposed
// to MCP clients). Kept here so bridge & extension import a shared spelling.
export const NmFrameType = {
  Command: 'command',
  Result:  'result',
  Cancel:  'cancel',
  Hello:   'hello',
  Status:  'status',
  Wake:    'wake',          // extension → bridge diagnostic on wake recovery
} as const;
export type NmFrameTypeName = (typeof NmFrameType)[keyof typeof NmFrameType];
