import { describe, expect, test } from 'bun:test';
import { decodeBatchResponse, RPCError, parseChunkedPayloads, stripAntiXssi } from '../../skills/notebooklm/scripts/rpc-client.ts';
import { fakeBatchBody, fixture } from '../helpers.ts';

describe('batchexecute decoder', () => {
  test('strips the anti-XSSI prefix with and without newline', () => {
    expect(stripAntiXssi(")]}'\n[1]")).toBe('[1]');
    expect(stripAntiXssi(")]}'\r\n[1]")).toBe('[1]');
    expect(stripAntiXssi(")]}'[1]")).toBe('[1]');
    expect(stripAntiXssi('[1]')).toBe('[1]');
  });

  test('parses rt=c chunk framing, ignoring byte-count lines', () => {
    const payloads = parseChunkedPayloads(")]}'\n\n12\n[[\"wrb.fr\"]]\n7\n[1,2,3]\n");
    expect(payloads).toEqual([[['wrb.fr']], [1, 2, 3]]);
  });

  test('decodes a recorded LIST_ARTIFACTS response', () => {
    const data = decodeBatchResponse(fixture('artifacts_list_video'), 'gArtLc') as unknown[][];
    expect(Array.isArray(data)).toBe(true);
    expect(Array.isArray(data[0])).toBe(true);
    expect(typeof data[0][0]).toBe('object');
  });

  test('returns null for RPCs that legitimately return nothing (status OK)', () => {
    expect(decodeBatchResponse(fakeBatchBody('cYAfTb', null, [0]), 'cYAfTb')).toBeNull();
    expect(decodeBatchResponse(fakeBatchBody('cYAfTb', null, null), 'cYAfTb')).toBeNull();
  });

  test('last non-null payload wins when placeholders precede the real frame', () => {
    const body =
      ")]}'\n" +
      JSON.stringify([['wrb.fr', 'rLM1Ne', null, null, null, null, 'generic']]) +
      '\n' +
      JSON.stringify([['wrb.fr', 'rLM1Ne', '[["ok"]]', null, null, null, 'generic']]) +
      '\n';
    expect(decodeBatchResponse(body, 'rLM1Ne')).toEqual([['ok']]);
  });

  test('maps a null payload with an INVALID_ARGUMENT status to a client RPCError', () => {
    expect(() => decodeBatchResponse(fakeBatchBody('R7cb6c', null, [3]), 'R7cb6c')).toThrow(RPCError);
    try {
      decodeBatchResponse(fakeBatchBody('R7cb6c', null, [3]), 'R7cb6c');
    } catch (e) {
      expect((e as RPCError).kind).toBe('client');
      expect((e as RPCError).code).toBe(3);
    }
  });

  test('flags UserDisplayableError status as a rate limit', () => {
    const status = [3, null, [['type.googleapis.com/google.internal.labs.tailwind.UserDisplayableError', 'x']]];
    try {
      decodeBatchResponse(fakeBatchBody('R7cb6c', null, status), 'R7cb6c');
      throw new Error('expected throw');
    } catch (e) {
      expect((e as RPCError).kind).toBe('rate_limit');
    }
  });

  test('"er" frames become RPCError', () => {
    const body = ")]}'\n" + JSON.stringify([['er', 'wXbhsf', 16]]) + '\n';
    try {
      decodeBatchResponse(body, 'wXbhsf');
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(RPCError);
      expect((e as RPCError).kind).toBe('auth');
    }
  });

  test('detects method-id drift when the requested id is absent but others are present', () => {
    try {
      decodeBatchResponse(fakeBatchBody('zzzzzz', [1]), 'wXbhsf');
      throw new Error('expected throw');
    } catch (e) {
      expect((e as RPCError).kind).toBe('drift');
      expect((e as Error).message).toContain('may have changed');
    }
  });

  test('an HTML login page (no envelopes) is reported clearly', () => {
    expect(() => decodeBatchResponse('<html><body>Sign in</body></html>', 'wXbhsf')).toThrow(/no batchexecute envelopes/);
  });
});
