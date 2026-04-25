import { Command } from '@byob/shared';
import { handleRead } from './read.js';
import { handleClick } from './click.js';
import { handleType } from './type.js';
import { handleNavigate } from './navigate.js';
import { handleWaitFor } from './wait-for.js';
import { handleScreenshot } from './screenshot.js';
import { handleGetCookies } from './get-cookies.js';
import { handleListTabs } from './list-tabs.js';
import { handleSwitchTab } from './switch-tab.js';
import { handleEval } from './eval.js';
import { handleDownloadImages } from './download-images.js';
import { handleGetConsoleLogs } from './get-console-logs.js';
import { handleReadMarkdown } from './read-markdown.js';
import { handleExtractTable } from './extract-table.js';
import { handleStartRecordNetwork } from './start-record-network.js';
import { handleStopRecordNetwork } from './stop-record-network.js';

export type Handler = (params: unknown, signal: AbortSignal) => Promise<unknown>;
// During the rollout (Tasks 4–7), individual handlers may still ignore the
// second arg. Tasks 5–7 wire them in. Casting through `as Handler` keeps the
// map happy while the rollout is in flight; Task 7 removes these casts once
// every handler honors the signature natively.

export const handlers: Partial<Record<string, Handler>> = {
  [Command.Read]: handleRead as Handler,
  [Command.Click]: handleClick as Handler,
  [Command.Type]: handleType as Handler,
  [Command.Navigate]: handleNavigate as Handler,
  [Command.WaitFor]: handleWaitFor as Handler,
  [Command.Screenshot]: handleScreenshot as Handler,
  [Command.GetCookies]: handleGetCookies as Handler,
  [Command.ListTabs]: handleListTabs as Handler,
  [Command.SwitchTab]: handleSwitchTab as Handler,
  [Command.Eval]: handleEval as Handler,
  [Command.DownloadImages]: handleDownloadImages as Handler,
  [Command.GetConsoleLogs]: handleGetConsoleLogs as Handler,
  [Command.ReadMarkdown]: handleReadMarkdown as Handler,
  [Command.ExtractTable]: handleExtractTable as Handler,
  [Command.StartRecordNetwork]: handleStartRecordNetwork as Handler,
  [Command.StopRecordNetwork]: handleStopRecordNetwork as Handler,
};
