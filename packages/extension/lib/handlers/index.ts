import { Command } from '@byob/shared';
import { handleTabs, handleNavigate } from './tabs.js';
import { handleSnapshot } from './snapshot.js';
import { handleFind } from './find.js';
import { handleRead } from './read.js';
import { handleScreenshot } from './screenshot.js';
import { handleClick, handleHover } from './click.js';
import { handleType, handlePressKey } from './type.js';
import { handleSelect, handleScroll, handleDrag, handleUploadFile } from './interact.js';
import { handleWait } from './wait.js';
import {
  handleConsole,
  handleInspect,
  handleEvaluate,
  handleStorage,
  handleDialogTool,
  handleClipboard,
  handleEmulate,
  handleNetwork,
} from './state.js';
import { handleDownloadImages } from './download-images.js';
import { handlePolicy } from './policy.js';

export type Handler = (params: unknown, signal: AbortSignal) => Promise<unknown>;

export const handlers: Partial<Record<string, Handler>> = {
  [Command.Tabs]: handleTabs,
  [Command.Navigate]: handleNavigate,
  [Command.Snapshot]: handleSnapshot,
  [Command.Find]: handleFind,
  [Command.Read]: handleRead,
  [Command.Screenshot]: handleScreenshot,
  [Command.Console]: handleConsole,
  [Command.Inspect]: handleInspect,
  [Command.Click]: handleClick,
  [Command.Hover]: handleHover,
  [Command.Type]: handleType,
  [Command.PressKey]: handlePressKey,
  [Command.Select]: handleSelect,
  [Command.Scroll]: handleScroll,
  [Command.Drag]: handleDrag,
  [Command.UploadFile]: handleUploadFile,
  [Command.Wait]: handleWait,
  [Command.Evaluate]: handleEvaluate,
  [Command.Storage]: handleStorage,
  [Command.Dialog]: handleDialogTool,
  [Command.Clipboard]: (p) => handleClipboard(p),
  [Command.Emulate]: handleEmulate,
  [Command.Network]: handleNetwork,
  [Command.DownloadImages]: handleDownloadImages,
  // CLI only (`byob policy`); deliberately not an MCP tool.
  policy: (p) => handlePolicy(p),
};
