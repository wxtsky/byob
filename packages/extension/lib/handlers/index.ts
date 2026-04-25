import { Command } from '@byob/shared';
import { handleRead } from './read.js';
import { handleClick } from './click.js';
import { handleType } from './type.js';
import { handleNavigate } from './navigate.js';
import { handleWaitFor } from './wait-for.js';

export type Handler = (params: unknown) => Promise<unknown>;

export const handlers: Partial<Record<string, Handler>> = {
  [Command.Read]: handleRead,
  [Command.Click]: handleClick,
  [Command.Type]: handleType,
  [Command.Navigate]: handleNavigate,
  [Command.WaitFor]: handleWaitFor,
};
