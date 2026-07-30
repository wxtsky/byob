import { afterEach, describe, expect, test } from 'bun:test';
import {
  clearDialogRegistryForTest,
  getDialog,
  recordDialogClosed,
  recordDialogOpening,
} from '../dialog-registry.js';

afterEach(clearDialogRegistryForTest);

describe('dialog registry', () => {
  test('records an opening dialog without auto-accepting it', () => {
    recordDialogOpening(12, {
      type: 'confirm',
      message: 'Delete the project?',
      url: 'https://example.com/settings',
    });

    expect(getDialog(12)).toMatchObject({
      type: 'confirm',
      message: 'Delete the project?',
      url: 'https://example.com/settings',
    });
  });

  test('tracks prompt defaults and removes closed dialogs', () => {
    recordDialogOpening(4, {
      type: 'prompt',
      message: 'Name',
      defaultPrompt: 'Draft',
    });
    expect(getDialog(4)?.defaultPrompt).toBe('Draft');

    recordDialogClosed(4);
    expect(getDialog(4)).toBeUndefined();
  });

  test('keeps dialogs isolated by tab', () => {
    recordDialogOpening(1, { type: 'alert', message: 'one' });
    recordDialogOpening(2, { type: 'beforeunload', message: 'two' });
    recordDialogClosed(1);

    expect(getDialog(1)).toBeUndefined();
    expect(getDialog(2)?.type).toBe('beforeunload');
  });
});
