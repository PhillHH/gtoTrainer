import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { isHealthResponse } from '@gto/shared';
import { buildApp } from '../src/app.js';

describe('GET /healthz', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('antwortet mit 200 und einem Objekt gemaess HealthResponse-Vertrag', async () => {
    const response = await app.inject({ method: 'GET', url: '/healthz' });

    expect(response.statusCode).toBe(200);

    const body: unknown = response.json();
    // Prueft die echte HTTP-Antwort gegen den Vertrag aus packages/shared.
    expect(isHealthResponse(body)).toBe(true);
    expect(body).toEqual({ status: 'ok' });
  });
});
