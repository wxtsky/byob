import { Command } from '@byob/shared';
import { handleRead } from './read.js';

export type Handler = (params: unknown) => Promise<unknown>;

export const handlers: Partial<Record<string, Handler>> = {
  [Command.Read]: handleRead,
  // More handlers added in later phases.
};
