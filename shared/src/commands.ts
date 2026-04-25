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
} as const;

export type CommandName = (typeof Command)[keyof typeof Command];
