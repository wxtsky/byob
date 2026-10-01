import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { cookieHeader, netscapeCookieJar, saveCookieJar } from './cookies.js';

const cookies = [
  { name: 'sid', value: 'abc', domain: 'example.com', path: '/', secure: true, httpOnly: true, expires: 1893456000.5 },
  { name: 'pref', value: 'dark', domain: '.example.com', path: '/app' },
];

describe('cookie export', () => {
  it('builds a curl Cookie header', () => {
    expect(cookieHeader(cookies)).toBe('Cookie: sid=abc; pref=dark');
  });

  it('writes the Netscape jar curl, wget and yt-dlp read', () => {
    const lines = netscapeCookieJar(cookies).trimEnd().split('\n');
    expect(lines[0]).toBe('# Netscape HTTP Cookie File');
    expect(lines).toContain('#HttpOnly_example.com\tFALSE\t/\tTRUE\t1893456000\tsid\tabc');
    expect(lines).toContain('.example.com\tTRUE\t/app\tFALSE\t0\tpref\tdark');
  });

  it('saves with mode 0600 and only to an absolute .txt path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'byob-cookies-'));
    try {
      const file = path.join(dir, 'cookies.txt');
      fs.writeFileSync(file, 'old', { mode: 0o644 });
      saveCookieJar(file, cookies);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(() => saveCookieJar('cookies.txt', cookies)).toThrow(/absolute/);
      expect(() => saveCookieJar(path.join(dir, 'c.json'), cookies)).toThrow(/\.txt/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
