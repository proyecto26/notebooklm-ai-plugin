import { describe, expect, test } from 'bun:test';
import { buildCookieMap, hasRequiredCookies } from '../../skills/notebooklm/scripts/cookie-store.ts';

describe('cookie map', () => {
  test('prefers the per-service cookie scoped to notebook.google.com over the legacy notebooklm.google.com one', () => {
    // Chrome profiles that signed in before the rename hold both; sending the stale
    // one makes Google answer with ServiceLogin?osid=1 even though the session is valid.
    const map = buildCookieMap([
      { name: 'OSID', value: 'OLD', domain: 'notebooklm.google.com', path: '/' },
      { name: 'OSID', value: 'NEW', domain: 'notebook.google.com', path: '/' },
      { name: '__Secure-OSID', value: 'NEW-S', domain: 'notebook.google.com', path: '/' },
      { name: '__Secure-OSID', value: 'OLD-S', domain: 'notebooklm.google.com', path: '/' },
    ]);
    expect(map.OSID).toBe('NEW');
    expect(map['__Secure-OSID']).toBe('NEW-S');
  });

  test('prefers the .google.com root cookie over other subdomains, ignores non-Google cookies', () => {
    const map = buildCookieMap([
      { name: 'SID', value: 'sub', domain: 'accounts.google.com', path: '/' },
      { name: 'SID', value: 'root', domain: '.google.com', path: '/' },
      { name: 'foo', value: 'x', domain: 'example.com', path: '/' },
      { name: '__Secure-1PSID', value: 'p', domain: '.google.com', path: '/' },
    ]);
    expect(map.SID).toBe('root');
    expect(map.foo).toBeUndefined();
    expect(hasRequiredCookies(map)).toBe(true);
  });
});
