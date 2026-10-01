import { describe, expect, it } from 'vitest';
import {
  FERRY_METHODS,
  FERRY_METHOD_PARAMS_SCHEMAS,
  FERRY_PROTOCOL,
  HelloParamsSchema,
  HelloResultSchema,
  JsonRpcNotificationSchema,
  JsonRpcRequestSchema,
  JsonRpcResponseSchema,
} from '../src/index.js';

describe('ferry/1 JSON-RPC contract', () => {
  it('validates requests, responses, notifications, and hello payloads', () => {
    const readOutputParamsSchema = FERRY_METHOD_PARAMS_SCHEMAS['sessions.readOutput'];
    if (!readOutputParamsSchema) throw new Error('Missing sessions.readOutput parameter schema');
    expect(FERRY_PROTOCOL).toBe('ferry/1');
    expect(FERRY_METHODS).toContain('sessions.send');
    expect(FERRY_METHODS).toContain('sessions.readOutput');
    expect(
      readOutputParamsSchema.safeParse([{ sessionId: 'session_1', handle: 'recovery_1' }]).success,
    ).toBe(true);
    expect(readOutputParamsSchema.safeParse([{ sessionId: 'session_1', handle: '' }]).success).toBe(
      false,
    );
    expect(
      JsonRpcRequestSchema.safeParse({
        jsonrpc: '2.0',
        id: 1,
        method: 'sessions.send',
        params: ['s1', { text: 'hello' }],
      }).success,
    ).toBe(true);
    expect(
      JsonRpcRequestSchema.safeParse({ jsonrpc: '1.0', id: 1, method: 'sessions.send' }).success,
    ).toBe(false);
    expect(
      JsonRpcNotificationSchema.safeParse({ jsonrpc: '2.0', method: 'session.updated', params: {} })
        .success,
    ).toBe(true);
    expect(
      JsonRpcResponseSchema.safeParse({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32004, message: 'missing', data: { kind: 'not_implemented' } },
      }).success,
    ).toBe(true);
    expect(
      HelloParamsSchema.safeParse({ protocol: FERRY_PROTOCOL, capabilities: [] }).success,
    ).toBe(true);
    expect(
      HelloResultSchema.safeParse({
        protocol: FERRY_PROTOCOL,
        capabilities: [],
        realDomains: [],
        implementedMethods: [],
      }).success,
    ).toBe(true);
  });
});
