import { hash, verify } from '@node-rs/argon2';

/**
 * Kennung fuer argon2id.
 *
 * `@node-rs/argon2` exportiert dafuer den ambienten const-enum
 * `Algorithm.Argon2id`. Der laesst sich mit `isolatedModules` nicht
 * referenzieren (TS2748), deshalb hier der Zahlenwert aus dessen
 * Typdefinition - bewusst benannt statt als nackte 2 im Optionsobjekt.
 */
const ALGORITHM_ARGON2ID = 2;

/**
 * Passwort-Hashing mit argon2id.
 *
 * Parameter siehe ADR-0007. Sie orientieren sich an der zweiten Empfehlung des
 * OWASP Password Storage Cheat Sheet (19 MiB Speicher, 2 Iterationen, 1 Thread)
 * und sind bewusst konservativ gewaehlt: Das Backend teilt sich den Host mit
 * anderen Projekten, ein Login-Vorgang darf nicht mehrere Hundert MB belegen.
 */
export const ARGON2_OPTIONS = {
  algorithm: ALGORITHM_ARGON2ID,
  /** 19 MiB - OWASP-Mindestempfehlung fuer argon2id mit t=2. */
  memoryCost: 19_456,
  /** Iterationen (time cost). */
  timeCost: 2,
  /** Ein Thread: der Host ist geteilt, Parallelitaet bringt hier nichts. */
  parallelism: 1,
} as const;

/** Mindestlaenge fuer neue Passwoerter. */
export const MIN_PASSWORD_LENGTH = 12;

/**
 * Dummy-Hash gegen Timing-Angriffe.
 *
 * Ist der Benutzername unbekannt, gibt es keinen Hash, gegen den geprueft
 * werden koennte - ein sofortiges `false` waere messbar schneller als ein
 * echter Verify und wuerde die Existenz des Kontos verraten. Deshalb wird in
 * diesem Fall gegen diesen Dummy verifiziert, was denselben Aufwand kostet.
 *
 * Lazy erzeugt und gecacht: Das Hashen kostet ~30 ms und soll nicht bei jedem
 * Fehlversuch neu anfallen, aber auch nicht den Start verzoegern.
 */
let dummyHashPromise: Promise<string> | undefined;

function getDummyHash(): Promise<string> {
  dummyHashPromise ??= hash('nicht-vergebenes-dummy-passwort', ARGON2_OPTIONS);
  return dummyHashPromise;
}

/** Erzeugt einen argon2id-Hash. Der Salt steckt im zurueckgegebenen String. */
export function hashPassword(plaintext: string): Promise<string> {
  return hash(plaintext, ARGON2_OPTIONS);
}

/**
 * Prueft ein Passwort gegen einen Hash.
 *
 * `storedHash === undefined` bedeutet "Benutzer existiert nicht". Es wird
 * trotzdem ein vollstaendiger Verify gegen den Dummy-Hash ausgefuehrt, damit
 * der Zeitaufwand derselbe ist wie bei einem existierenden Konto.
 */
export async function verifyPassword(
  storedHash: string | undefined,
  plaintext: string,
): Promise<boolean> {
  if (storedHash === undefined) {
    await verify(await getDummyHash(), plaintext).catch(() => false);
    return false;
  }

  try {
    return await verify(storedHash, plaintext);
  } catch {
    // Unlesbarer oder beschaedigter Hash gilt als "passt nicht".
    return false;
  }
}

/** Ergebnis der Passwort-Richtlinienpruefung. */
export type PasswordPolicyResult = { ok: true } | { ok: false; reason: string };

/** Prueft die Mindestanforderungen an ein neues Passwort. */
export function checkPasswordPolicy(plaintext: string): PasswordPolicyResult {
  if (plaintext.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      reason: `Das Passwort muss mindestens ${MIN_PASSWORD_LENGTH} Zeichen lang sein (ist: ${plaintext.length}).`,
    };
  }
  if (plaintext.trim().length === 0) {
    return { ok: false, reason: 'Das Passwort darf nicht nur aus Leerzeichen bestehen.' };
  }
  return { ok: true };
}
