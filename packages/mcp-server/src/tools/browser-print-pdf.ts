import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PrintPdfInputRaw, PrintPdfOutput } from '@byob/shared';
import { bridgePost } from '../bridge-client.js';
import { asErrorEnvelope, toMcpError } from '../error-mapper.js';

export function registerBrowserPrintPdf(server: McpServer): void {
  server.registerTool(
    'browser_print_pdf',
    {
      title: 'Save the current page as a PDF file',
      description:
        'Save the current page as a PDF file. Returns the file PATH (not data) — read ' +
        'the file with the Read tool when needed. Default save dir is `~/.byob/pdfs/`. ' +
        "Supports paperFormat ('A4' / 'Letter' / 'Legal'), landscape, page ranges, " +
        'background printing (default true), and uniform margin in inches. Times out after 120s; use pageRanges for very large docs.',
      inputSchema: PrintPdfInputRaw.shape,
    },
    async (args, extra) => {
      const { status, body } = await bridgePost('/print-pdf', args, { signal: extra.signal });
      if (status >= 400) return toMcpError(asErrorEnvelope(body, `bridge ${status}`));
      const parsed = PrintPdfOutput.safeParse(body);
      if (!parsed.success) return toMcpError({ error: 'unknown', message: parsed.error.message });
      return { content: [{ type: 'text', text: JSON.stringify(parsed.data) }] };
    },
  );
}
