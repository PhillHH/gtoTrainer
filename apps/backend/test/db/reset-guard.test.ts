import { describe, expect, it } from 'vitest';
import { ResetBlockedError, assertResetAllowed } from '../../src/db/reset.js';

describe('db:reset - Schutz gegen versehentliche Ausfuehrung', () => {
  it('blockiert bei NODE_ENV=production, auch mit Bestaetigung', () => {
    expect(() => assertResetAllowed({ nodeEnv: 'production', confirm: 'yes' })).toThrow(
      ResetBlockedError,
    );
    expect(() => assertResetAllowed({ nodeEnv: 'production', confirm: 'yes' })).toThrow(
      /NODE_ENV=production/,
    );
  });

  it('blockiert, wenn die Bestaetigung fehlt oder abweicht', () => {
    expect(() => assertResetAllowed({ nodeEnv: 'development', confirm: undefined })).toThrow(
      /Bestaetigung fehlt/,
    );
    expect(() => assertResetAllowed({ nodeEnv: 'development', confirm: 'no' })).toThrow(
      /Bestaetigung fehlt/,
    );
    expect(() => assertResetAllowed({ nodeEnv: 'development', confirm: 'YES' })).toThrow(
      /Bestaetigung fehlt/,
    );
  });

  it('laesst den Reset in der Entwicklung mit Bestaetigung zu', () => {
    expect(() => assertResetAllowed({ nodeEnv: 'development', confirm: 'yes' })).not.toThrow();
    expect(() => assertResetAllowed({ nodeEnv: undefined, confirm: 'yes' })).not.toThrow();
  });
});
