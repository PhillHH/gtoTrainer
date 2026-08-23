import { describe, expect, it } from 'vitest';
import { HEALTH_STATUS_OK, isHealthResponse } from '../src/index.js';
import type { HealthResponse } from '../src/index.js';

describe('HealthResponse-Vertrag', () => {
  it('akzeptiert eine gueltige Health-Antwort', () => {
    const payload: HealthResponse = { status: HEALTH_STATUS_OK };
    expect(isHealthResponse(payload)).toBe(true);
  });

  it('weist Werte zurueck, die den Vertrag verletzen', () => {
    expect(isHealthResponse(null)).toBe(false);
    expect(isHealthResponse({})).toBe(false);
    expect(isHealthResponse({ status: 'degraded' })).toBe(false);
    expect(isHealthResponse('ok')).toBe(false);
  });
});
