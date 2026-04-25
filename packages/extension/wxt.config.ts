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
    key: 'REPLACE_WITH_BASE64_DER_PUBLIC_KEY',
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
