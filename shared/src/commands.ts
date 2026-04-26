export const Command = {
  Read:        'readPage',
  Screenshot:  'screenshot',
  Click:       'click',
  Type:        'type',
  GetCookies:  'getCookies',
  Eval:        'eval',
  Navigate:    'navigate',
  WaitFor:     'waitFor',
  ListTabs:    'listTabs',
  SwitchTab:   'switchTab',
  DownloadImages: 'downloadImages',
  GetConsoleLogs: 'getConsoleLogs',
  ReadMarkdown:   'readMarkdown',
  ExtractTable:   'extractTable',
  StartRecordNetwork: 'startRecordNetwork',
  StopRecordNetwork:  'stopRecordNetwork',
  // v0.3 Batch 1
  Scroll:      'scroll',
  PressKey:    'pressKey',
  Select:      'select',
  CloseTab:    'closeTab',
  GoBack:      'goBack',
  GoForward:   'goForward',
  Hover:       'hover',
  GetHtml:     'getHtml',
  // v0.3 Batch 2
  SetCookies:     'setCookies',
  PrintPdf:       'printPdf',
  GetStorage:     'getStorage',
  GetPerformance: 'getPerformance',
  UploadFile:     'uploadFile',
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
