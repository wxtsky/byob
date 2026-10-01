/** Cookies from browser_storage as a curl header or a Netscape cookies.txt. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { checkSavePath } from './files.js';

export interface CookieRow {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Unix seconds; absent for session cookies. */
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
}

/** `Cookie: a=1; b=2` — paste into curl -H. */
export function cookieHeader(cookies: CookieRow[]): string {
  return `Cookie: ${cookies.map((c) => `${c.name}=${c.value}`).join('; ')}`;
}

/**
 * The Netscape cookie-jar format curl (-b), wget (--load-cookies) and yt-dlp
 * (--cookies) read: one tab-separated line per cookie. A leading dot on the
 * domain means "and its subdomains"; curl marks HttpOnly cookies with a
 * `#HttpOnly_` prefix on the domain.
 */
export function netscapeCookieJar(cookies: CookieRow[]): string {
  const lines = ['# Netscape HTTP Cookie File', '# Written by byob. Contains session secrets: keep it private.', ''];
  for (const c of cookies) {
    const domain = `${c.httpOnly ? '#HttpOnly_' : ''}${c.domain}`;
    lines.push([
      domain,
      c.domain.startsWith('.') ? 'TRUE' : 'FALSE',
      c.path || '/',
      c.secure ? 'TRUE' : 'FALSE',
      String(c.expires ? Math.floor(c.expires) : 0),
      c.name,
      c.value,
    ].join('\t'));
  }
  return lines.join('\n') + '\n';
}

/** Write the jar (mode 0600). `savePath` must be an absolute .txt path. */
export function saveCookieJar(savePath: string, cookies: CookieRow[]): string {
  checkSavePath(savePath, 'txt');
  fs.mkdirSync(path.dirname(savePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(savePath, netscapeCookieJar(cookies), { mode: 0o600 });
  // writeFileSync keeps an existing file's mode; tighten it either way.
  fs.chmodSync(savePath, 0o600);
  return savePath;
}
