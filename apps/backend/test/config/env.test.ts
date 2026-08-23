import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config/env.js';

describe('Konfigurations-Validierung', () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env['DATABASE_URL'];
  });

  afterEach(() => {
    if (original === undefined) delete process.env['DATABASE_URL'];
    else process.env['DATABASE_URL'] = original;
  });

  it('meldet eine fehlende Pflichtvariable verstaendlich, statt still abzustuerzen', () => {
    process.env['DATABASE_URL'] = '';
    expect(() => loadConfig()).toThrow(ConfigError);
    expect(() => loadConfig()).toThrow(/DATABASE_URL fehlt oder ist leer/);
  });

  it('weist eine URL mit falschem Protokoll ab', () => {
    process.env['DATABASE_URL'] = 'mysql://gto:pw@127.0.0.1:3306/gto';
    expect(() => loadConfig()).toThrow(/postgres:\/\//);
  });

  it('weist den unveraenderten Platzhalter aus .env.example ab', () => {
    process.env['DATABASE_URL'] = 'postgres://gto:__SET_A_STRONG_PASSWORD__@127.0.0.1:55434/gto';
    expect(() => loadConfig()).toThrow(/Platzhalter/);
  });

  it('akzeptiert eine gueltige Konfiguration', () => {
    process.env['DATABASE_URL'] = 'postgres://gto:secret@127.0.0.1:55434/gto';
    const config = loadConfig();
    expect(config.databaseUrl).toBe('postgres://gto:secret@127.0.0.1:55434/gto');
    expect(config.port).toBeGreaterThan(0);
  });
});
