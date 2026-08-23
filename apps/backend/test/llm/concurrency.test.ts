import { describe, expect, it } from 'vitest';
import { Semaphore, withRetry } from '../../src/llm/concurrency.js';

describe('Semaphore', () => {
  it('laesst hoechstens `limit` Aufgaben gleichzeitig laufen', async () => {
    const semaphore = new Semaphore(2);
    let running = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 8 }, () =>
        semaphore.run(async () => {
          running += 1;
          peak = Math.max(peak, running);
          await new Promise((resolve) => setTimeout(resolve, 10));
          running -= 1;
        }),
      ),
    );

    expect(peak).toBe(2);
    expect(semaphore.inFlight).toBe(0);
    expect(semaphore.waiting).toBe(0);
  });

  it('gibt den Platz auch nach einem Fehler frei', async () => {
    const semaphore = new Semaphore(1);
    await expect(semaphore.run(() => Promise.reject(new Error('kaputt')))).rejects.toThrow(
      'kaputt',
    );
    expect(semaphore.inFlight).toBe(0);
    await expect(semaphore.run(() => Promise.resolve('geht'))).resolves.toBe('geht');
  });

  it('weist ein unsinniges Limit ab', () => {
    expect(() => new Semaphore(0)).toThrow(RangeError);
  });
});

describe('withRetry', () => {
  const policy = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000, totalBudgetMs: 10_000 };
  const noWait = { sleep: () => Promise.resolve(), random: () => 0.5 };

  it('wiederholt wiederholbare Fehler bis zum Erfolg', async () => {
    let attempts = 0;
    const result = await withRetry(
      () => {
        attempts += 1;
        if (attempts < 3) return Promise.reject(new Error('transient'));
        return Promise.resolve('fertig');
      },
      policy,
      { isRetryable: () => true, ...noWait },
    );

    expect(result).toBe('fertig');
    expect(attempts).toBe(3);
  });

  it('gibt nicht wiederholbare Fehler sofort weiter', async () => {
    let attempts = 0;
    await expect(
      withRetry(
        () => {
          attempts += 1;
          return Promise.reject(new Error('auth'));
        },
        policy,
        { isRetryable: () => false, ...noWait },
      ),
    ).rejects.toThrow('auth');
    expect(attempts).toBe(1);
  });

  it('haelt sich an maxAttempts', async () => {
    let attempts = 0;
    await expect(
      withRetry(
        () => {
          attempts += 1;
          return Promise.reject(new Error('immer kaputt'));
        },
        policy,
        { isRetryable: () => true, ...noWait },
      ),
    ).rejects.toThrow('immer kaputt');
    expect(attempts).toBe(3);
  });

  it('waechst exponentiell und streut den Backoff', async () => {
    const delays: number[] = [];
    await expect(
      withRetry(
        () => Promise.reject(new Error('kaputt')),
        { maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 1_000, totalBudgetMs: 10_000 },
        {
          isRetryable: () => true,
          sleep: (ms) => {
            delays.push(ms);
            return Promise.resolve();
          },
          // Volle Streuung: 0 -> halber Wert, 1 -> voller Wert.
          random: () => 1,
        },
      ),
    ).rejects.toThrow();

    expect(delays).toEqual([100, 200, 400]);
  });

  it('bricht ab, wenn der naechste Versuch das Gesamtbudget sprengen wuerde', async () => {
    let attempts = 0;
    let clock = 0;
    await expect(
      withRetry(
        () => {
          attempts += 1;
          return Promise.reject(new Error('kaputt'));
        },
        { maxAttempts: 10, baseDelayMs: 1_000, maxDelayMs: 1_000, totalBudgetMs: 1_500 },
        {
          isRetryable: () => true,
          random: () => 1,
          now: () => clock,
          sleep: (ms) => {
            clock += ms;
            return Promise.resolve();
          },
        },
      ),
    ).rejects.toThrow('kaputt');

    // Erster Versuch, ein Backoff von 1000 ms, dann sprengt der naechste das Budget.
    expect(attempts).toBe(2);
  });

  it('beachtet eine vom Fehler vorgegebene Mindestwartezeit', async () => {
    const delays: number[] = [];
    await expect(
      withRetry(
        () => Promise.reject(new Error('rate limit')),
        { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 20, totalBudgetMs: 10_000 },
        {
          isRetryable: () => true,
          retryAfterMs: () => 5_000,
          random: () => 1,
          sleep: (ms) => {
            delays.push(ms);
            return Promise.resolve();
          },
        },
      ),
    ).rejects.toThrow();

    expect(delays).toEqual([5_000]);
  });
});
