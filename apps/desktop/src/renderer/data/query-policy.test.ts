import { describe, expect, it } from 'vitest';
import { queryPolicy } from './query-policy';

describe('renderer query policies', () => {
  it('keeps relatively static domains warm longer than live session and quota data', () => {
    expect(queryPolicy(['profiles']).staleTime).toBeGreaterThan(0);
    expect(queryPolicy(['sessions']).staleTime).toBe(Number.POSITIVE_INFINITY);
    expect(queryPolicy(['capacity']).staleTime).toBe(Number.POSITIVE_INFINITY);
    expect(queryPolicy(['model-candidates', 's1']).staleTime).toBe(30_000);
    expect(queryPolicy(['settings']).gcTime).toBeGreaterThan(queryPolicy(['capacity']).gcTime);
    expect(queryPolicy(['usage', 'history', 14]).staleTime).toBeGreaterThan(0);
    expect(queryPolicy(['session', 's1']).staleTime).toBe(queryPolicy(['sessions']).staleTime);
  });
});
