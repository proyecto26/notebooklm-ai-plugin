import { SAMPLES } from './samples.ts';

/**
 * Returns a minimal, real-derived batchexecute response body for the offline
 * decoder tests. Data lives inline in `samples.ts` (reviewable in the diff);
 * live parsing against the real service is covered by `live.test.ts`.
 */
export function fixture(name: string): string {
  const body = SAMPLES[name];
  if (body === undefined) throw new Error(`Unknown sample fixture: ${name}`);
  return body;
}

/** Wraps a decoded payload back into a minimal batchexecute body for a given rpc id. */
export function fakeBatchBody(rpcId: string, payload: unknown, status: unknown = null): string {
  const inner = payload === null ? null : JSON.stringify(payload);
  const frame = JSON.stringify([['wrb.fr', rpcId, inner, null, null, status, 'generic']]);
  return `)]}'\n\n${frame.length}\n${frame}\n`;
}
