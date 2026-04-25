import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: {
    name: 'byob — Bring Your Own Browser',
    description: 'Local-only browser bridge for AI agents (MCP)',
    version: '0.1.0',
    // PUBLIC KEY (base64 of DER) — pins extension ID across reloads.
    // Generate via: openssl genrsa -out ~/.byob/extension-key.pem 2048
    //               openssl rsa -in ~/.byob/extension-key.pem -pubout -outform DER | base64 | tr -d '\n'
    // Replace this placeholder before Phase 1 install step.
    key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAxe4No3LLOli3nxxIl4uXDbRvFl20UhJVhm7AbQ8AnkFlGVFiP3JNQERkQoyrM4HGRpsRwrkgB530D6lojfG+xtJ+8GdBNRUvAV/gzWcsfbinZxrPTeGHq+yRGaNP99Tf0TRw+Fh/nAc6RvnYdhsF0Vgc0fY0akqRxmHrOndqyY3G8ncRuy5KXtYciK6eLxprRoVJM1+1QX7/1IhdCLPhkB4ceL9cUovFGbdvW6fDLa0WxIc0Ln9H/FzEp0Wf046Zwbn6N92XCc9zp9z32qM1U6yxchwr8COrvCeBx0J2c3LYOUdeT08XvicgyDLQeWfoNkVf32UtjZicK2fJk6uG7QIDAQAB',
    permissions: [
      'debugger',
      'tabs',
      'scripting',
      'cookies',
      'nativeMessaging',
      'storage',
      'alarms',
      'power',
      'notifications',
      'offscreen',
    ],
    host_permissions: ['<all_urls>'],
    minimum_chrome_version: '116',
  },
});
