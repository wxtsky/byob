import { UploadFileInput } from '@byob/shared';
import { tryAttachToTab } from '../cdp.js';
import {
  resolveFrame,
  sendInResolvedFrame,
  frameErrorToEnvelope,
  type ResolvedFrame,
} from '../frame-resolver.js';
import { openOrReuse } from '../tab.js';
import { checkUrlAllowed, urlForbiddenError } from '../url-guard.js';
import { throwIfAborted } from '../signal-utils.js';
import { attachErrorEnvelope } from '../attach-error.js';
import { resolveByobIdxSelector } from './selector-resolver.js';

export async function handleUploadFile(
  rawParams: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const params = UploadFileInput.parse(rawParams);
  const selector = resolveByobIdxSelector(params.selector);
  if (params.url) {
    const guard = checkUrlAllowed(params.url);
    if (!guard.ok) return urlForbiddenError(guard.reason);
  }
  throwIfAborted(signal);

  const tab = await openOrReuse({ url: params.url, tabId: params.tabId, signal });
  // No tab cleanup on success: this is an interactive/mutation tool. Like
  // scroll/hover/click/type/select/press-key, the caller typically continues
  // operating on the tab (submit form, verify upload). See scroll.ts for the
  // shared rationale.

  const attachResult = await tryAttachToTab(tab.tabId, signal);
  const { session } = attachResult;
  if (!session) return attachErrorEnvelope(attachResult);

  let frame: ResolvedFrame;
  try {
    frame = await resolveFrame(session, params.framePath, signal);
  } catch (e) {
    const env = frameErrorToEnvelope(e);
    if (env) return env;
    throw e;
  }

  // Binds this frame + signal so the eight CDP calls below stay readable.
  // The routing itself lives in frame-resolver.
  const onFrame = <T>(method: string, cdpParams: Record<string, unknown>): Promise<T> =>
    sendInResolvedFrame<T>(session, frame, method, cdpParams, signal);

  const sel = JSON.stringify(selector);

  // Step A: validate the selector (returnByValue:true — no objectId needed).
  const validateExpr = `(() => {
    const el = document.querySelector(${sel});
    if (!el) return { ok: false, reason: 'selector_not_found' };
    if (el.tagName !== 'INPUT' || (el.type ?? '').toLowerCase() !== 'file') {
      return { ok: false, reason: 'not_a_file_input' };
    }
    return { ok: true };
  })()`;
  const validation = await onFrame<{
    result: { value?: { ok: boolean; reason?: string } };
    exceptionDetails?: unknown;
  }>('Runtime.evaluate', {
    contextId: frame.contextId,
    expression: validateExpr,
    returnByValue: true,
  });
  if (validation.exceptionDetails) {
    return { error: 'eval_exception', message: 'validate selector threw' };
  }
  const v = validation.result?.value ?? { ok: false, reason: 'selector_not_found' };
  if (!v.ok) {
    if (v.reason === 'not_a_file_input') {
      return {
        error: 'not_a_file_input',
        message: `Selector ${params.selector} is not <input type="file">`,
      };
    }
    return {
      error: 'selector_not_found',
      message: `No element matched ${params.selector}`,
    };
  }

  // Step B–D wrapped — DOM mutations between calls can trigger CDP errors,
  // which would otherwise escape as unhandled rejections.
  try {
    // Step B: get the element's backendNodeId via Runtime.evaluate
    // (returnByValue:false → objectId) → DOM.requestNode → DOM.describeNode.
    // This path is OOPIF-safe because all three commands ride the same session.
    const handle = await onFrame<{
      result: { objectId?: string };
      exceptionDetails?: unknown;
    }>('Runtime.evaluate', {
      contextId: frame.contextId,
      expression: `document.querySelector(${sel})`,
      returnByValue: false,
    });
    if (handle.exceptionDetails) {
      return { error: 'eval_exception', message: 'querySelector threw in Step B' };
    }
    if (!handle.result?.objectId) {
      return {
        error: 'selector_not_found',
        message: `No element matched ${params.selector}`,
      };
    }
    const node = await onFrame<{ nodeId: number }>('DOM.requestNode', {
      objectId: handle.result.objectId,
    });
    if (!node.nodeId) {
      return {
        error: 'selector_not_found',
        message: `No element matched ${params.selector}`,
      };
    }
    const desc = await onFrame<{ node: { backendNodeId: number } }>('DOM.describeNode', {
      nodeId: node.nodeId,
    });
    if (!desc.node?.backendNodeId) {
      return {
        error: 'selector_not_found',
        message: `Node disappeared before backendNodeId could be resolved`,
      };
    }

    // Step C: set the files. Chrome reads each path with the user's permissions,
    // so MCP client must run on the same machine as Chrome.
    await onFrame('DOM.setFileInputFiles', {
      backendNodeId: desc.node.backendNodeId,
      files: params.paths,
    });

    // Step D: fire input + change events so React/Vue forms detect the upload
    // (DOM.setFileInputFiles by itself doesn't dispatch them).
    await onFrame('Runtime.evaluate', {
      contextId: frame.contextId,
      expression: `(() => {
        const el = document.querySelector(${sel});
        if (el) {
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      })()`,
      returnByValue: true,
    });
  } catch (e) {
    return {
      error: 'unknown',
      message: `CDP error during file upload: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const tabInfo = await chrome.tabs.get(tab.tabId).catch(() => null);
  return {
    tabId: tab.tabId,
    url: tabInfo?.url ?? params.url ?? '',
    // bridge route fills `files` with name/size from fs.stat; handler
    // doesn't need to echo paths because bridge already has them from
    // the original request body.
  };
}

