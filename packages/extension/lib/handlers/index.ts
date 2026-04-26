import { Command } from '@byob/shared';
import { handleRead } from './read.js';
import { handleClick } from './click.js';
import { handleCloseTab } from './close-tab.js';
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
import { handleScroll } from './scroll.js';
import { handlePressKey } from './press-key.js';
import { handleSelect } from './select.js';
import { handleGoBack } from './go-back.js';
import { handleGoForward } from './go-forward.js';
import { handleHover } from './hover.js';
import { handleGetHtml } from './get-html.js';
import { handleSetCookies } from './set-cookies.js';
import { handlePrintPdf } from './print-pdf.js';
import { handleGetStorage } from './get-storage.js';
import { handleGetPerformance } from './get-performance.js';
import { handleUploadFile } from './upload-file.js';
import { handleInterceptStart } from './intercept-start.js';
import { handleInterceptStop } from './intercept-stop.js';

export type Handler = (params: unknown, signal: AbortSignal) => Promise<unknown>;

export const handlers: Partial<Record<string, Handler>> = {
  [Command.Read]: handleRead,
  [Command.Click]: handleClick,
  [Command.Type]: handleType,
  [Command.Navigate]: handleNavigate,
  [Command.WaitFor]: handleWaitFor,
  [Command.Screenshot]: handleScreenshot,
  [Command.GetCookies]: handleGetCookies,
  [Command.ListTabs]: handleListTabs,
  [Command.SwitchTab]: handleSwitchTab,
  [Command.Eval]: handleEval,
  [Command.DownloadImages]: handleDownloadImages,
  [Command.GetConsoleLogs]: handleGetConsoleLogs,
  [Command.ReadMarkdown]: handleReadMarkdown,
  [Command.ExtractTable]: handleExtractTable,
  [Command.StartRecordNetwork]: handleStartRecordNetwork,
  [Command.StopRecordNetwork]: handleStopRecordNetwork,
  [Command.Scroll]: handleScroll,
  [Command.PressKey]: handlePressKey,
  [Command.Select]: handleSelect,
  [Command.CloseTab]: handleCloseTab,
  [Command.GoBack]: handleGoBack,
  [Command.GoForward]: handleGoForward,
  [Command.Hover]: handleHover,
  [Command.GetHtml]: handleGetHtml,
  [Command.SetCookies]: handleSetCookies,
  [Command.PrintPdf]: handlePrintPdf,
  [Command.GetStorage]: handleGetStorage,
  [Command.GetPerformance]: handleGetPerformance,
  [Command.UploadFile]: handleUploadFile,
  [Command.InterceptStart]: handleInterceptStart,
  [Command.InterceptStop]: handleInterceptStop,
};
