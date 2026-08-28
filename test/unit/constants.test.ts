import { describe, expect, test } from 'bun:test';
import { BATCHEXECUTE_URL, CHAT_STREAM_URL, NOTEBOOKLM_ORIGIN, UPLOAD_URL, isNotebookLMAppUrl, notebookUrl } from '../../skills/notebooklm/scripts/constants.ts';
import { extractNotebookId } from '../../skills/notebooklm/scripts/notebook-manager.ts';

describe('NotebookLM origin (renamed to notebook.google.com in 2026)', () => {
  test('all endpoints are built from the current origin', () => {
    expect(NOTEBOOKLM_ORIGIN).toBe('https://notebook.google.com');
    expect(BATCHEXECUTE_URL).toBe('https://notebook.google.com/_/LabsTailwindUi/data/batchexecute');
    expect(CHAT_STREAM_URL).toContain('https://notebook.google.com/_/LabsTailwindUi/data/google.internal.labs.tailwind.orchestration.v1');
    expect(UPLOAD_URL).toBe('https://notebook.google.com/upload/_/');
    expect(notebookUrl('abc')).toBe('https://notebook.google.com/notebook/abc');
  });

  test('both the new and legacy hosts are recognised as app URLs; login/accounts are not', () => {
    expect(isNotebookLMAppUrl('https://notebook.google.com/notebook/x')).toBe(true);
    expect(isNotebookLMAppUrl('https://notebooklm.google.com/')).toBe(true);
    expect(isNotebookLMAppUrl('https://accounts.google.com/v3/signin')).toBe(false);
    expect(isNotebookLMAppUrl('not a url')).toBe(false);
  });

  test('notebook ids extract from either host', () => {
    expect(extractNotebookId('https://notebook.google.com/notebook/0c88d4b3-1815-44de-9716-5f24d2798ddd?x=1')).toBe('0c88d4b3-1815-44de-9716-5f24d2798ddd');
    expect(extractNotebookId('https://notebooklm.google.com/notebook/abc/')).toBe('abc');
    expect(extractNotebookId('abc')).toBe('abc');
  });
});
