import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CSRF_HEADER_NAME } from '@gto/shared';
import type { ConceptListResponse, ConceptUpdateResponse } from '@gto/shared';
import { concept, conceptPrerequisite, user } from '../../src/db/schema.js';
import { normalizeSuggestions } from '../../src/concept/normalize.js';
import { persistConcepts } from '../../src/concept/store.js';
import { createTestContext, createTestUser, login } from '../auth/helpers.js';
import type { TestContext } from '../auth/helpers.js';
import { clearAll, seedBook } from './helpers.js';

/**
 * Review-Endpunkte des Konzept-Graphen (AP3.T3.2). Alle Routen sind
 * auth-geschuetzt; die schreibenden brauchen zusaetzlich das CSRF-Token.
 */

const USERNAME = 'konzept-review-user';
const PASSWORD = 'konzept-review-passwort-lang';

let context: TestContext;
let cookieHeader: string;
let csrfToken: string;

beforeAll(async () => {
  context = await createTestContext();
  await createTestUser(context, USERNAME, PASSWORD);
  const session = await login(context.app, USERNAME, PASSWORD);
  cookieHeader = session.cookieHeader;
  csrfToken = session.csrfToken;
});

afterAll(async () => {
  await context.handle.db.delete(user).where(eq(user.username, USERNAME));
  await context.close();
});

beforeEach(async () => {
  await clearAll(context.handle.db);
  await seedBook(context.handle.db);
  await seed();
});

function suggestion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    titel: 'Pot Odds',
    kurzdefinition: 'Verhaeltnis von Einsatz zu moeglichem Gewinn, an dem sich ein Call misst.',
    themenbereich: 'grundlagen-mathematik',
    ab_level: 'einsteiger',
    voraussetzungen: [],
    sektionen: ['ch01/grundbegriffe'],
    ...overrides,
  };
}

async function seed(): Promise<void> {
  const normalized = normalizeSuggestions([
    suggestion(),
    suggestion({
      titel: 'Erwartungswert',
      voraussetzungen: ['Pot Odds'],
      sektionen: ['ch01/kennzahlen'],
    }),
    suggestion({
      titel: 'Ohne Sektion',
      voraussetzungen: ['Kennt niemand'],
      sektionen: [],
    }),
  ] as never);
  await persistConcepts(context.handle.db, 1, normalized.concepts);
}

/** Header fuer schreibende Requests. */
function writeHeaders(): Record<string, string> {
  return { cookie: cookieHeader, [CSRF_HEADER_NAME]: csrfToken };
}

async function list(): Promise<ConceptListResponse> {
  const response = await context.app.inject({
    method: 'GET',
    url: '/api/concepts',
    headers: { cookie: cookieHeader },
  });
  expect(response.statusCode).toBe(200);
  return response.json() as ConceptListResponse;
}

describe('GET /api/concepts', () => {
  it('verlangt eine Session', async () => {
    const response = await context.app.inject({ method: 'GET', url: '/api/concepts' });
    expect(response.statusCode).toBe(401);
  });

  it('gruppiert die Konzepte nach Kapitel und nennt die Zaehlstaende', async () => {
    const body = await list();
    expect(body.totals).toMatchObject({ concepts: 3, draft: 3, approved: 0 });

    const chapterOne = body.chapters.find((group) => group.chapterNumber === 1);
    expect(chapterOne?.concepts.map((entry) => entry.title)).toEqual([
      'Pot Odds',
      'Erwartungswert',
      'Ohne Sektion',
    ]);
    expect(body.topicAreas.length).toBeGreaterThan(0);
  });

  it('liefert aufgeloeste Voraussetzungen mit Titel', async () => {
    const body = await list();
    const ev = body.chapters
      .flatMap((group) => group.concepts)
      .find((entry) => entry.title === 'Erwartungswert');
    expect(ev?.prerequisites).toEqual([expect.objectContaining({ title: 'Pot Odds' })]);
  });

  it('weist Auffaelligkeiten aus', async () => {
    const body = await list();
    const kinds = body.issues.map((issue) => issue.kind);
    expect(kinds).toContain('without-section');
    expect(kinds).toContain('unresolved-prerequisite');
    expect(kinds).toContain('chapter-empty');
  });
});

describe('PATCH /api/concepts/:id', () => {
  it('aendert Titel, Kurzdefinition und Einordnung', async () => {
    const body = await list();
    const target = body.chapters[0]?.concepts[0];

    const response = await context.app.inject({
      method: 'PATCH',
      url: `/api/concepts/${target?.id}`,
      headers: writeHeaders(),
      payload: {
        title: 'Pot Odds (korrigiert)',
        summary: 'Neue Kurzdefinition.',
        topicArea: 'spieltheorie',
        minLevel: 'fortgeschritten',
      },
    });

    expect(response.statusCode).toBe(200);
    const updated = (response.json() as ConceptUpdateResponse).concept;
    expect(updated).toMatchObject({
      title: 'Pot Odds (korrigiert)',
      summary: 'Neue Kurzdefinition.',
      topicArea: 'spieltheorie',
      minLevel: 'fortgeschritten',
    });
  });

  it('lehnt einen unbekannten Themenbereich feldweise ab', async () => {
    const body = await list();
    const target = body.chapters[0]?.concepts[0];

    const response = await context.app.inject({
      method: 'PATCH',
      url: `/api/concepts/${target?.id}`,
      headers: writeHeaders(),
      payload: { topicArea: 'gibt-es-nicht' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: 'invalid_concept',
      fields: [expect.objectContaining({ field: 'topicArea' })],
    });
  });

  it('setzt Voraussetzungen neu und loescht die offenen Titel', async () => {
    const body = await list();
    const potOdds = body.chapters[0]?.concepts[0];
    const ohneSektion = body.chapters[0]?.concepts[2];

    const response = await context.app.inject({
      method: 'PATCH',
      url: `/api/concepts/${ohneSektion?.id}`,
      headers: writeHeaders(),
      payload: { prerequisiteIds: [potOdds?.id] },
    });

    expect(response.statusCode).toBe(200);
    const updated = (response.json() as ConceptUpdateResponse).concept;
    expect(updated.prerequisites).toEqual([expect.objectContaining({ id: potOdds?.id })]);
    expect(updated.unresolvedPrerequisites).toEqual([]);
  });

  it('lehnt eine Voraussetzung ab, die einen Zyklus schliessen wuerde', async () => {
    const body = await list();
    const potOdds = body.chapters[0]?.concepts[0];
    const ev = body.chapters[0]?.concepts[1];

    // Pot Odds soll Erwartungswert voraussetzen - Erwartungswert setzt aber
    // bereits Pot Odds voraus.
    const response = await context.app.inject({
      method: 'PATCH',
      url: `/api/concepts/${potOdds?.id}`,
      headers: writeHeaders(),
      payload: { prerequisiteIds: [ev?.id] },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'invalid_concept' });
    expect(await context.handle.db.select().from(conceptPrerequisite)).toHaveLength(1);
  });

  it('lehnt eine unbekannte Konzept-ID ab', async () => {
    const body = await list();
    const target = body.chapters[0]?.concepts[0];
    const response = await context.app.inject({
      method: 'PATCH',
      url: `/api/concepts/${target?.id}`,
      headers: writeHeaders(),
      payload: { prerequisiteIds: ['11111111-1111-4111-8111-111111111111'] },
    });
    expect(response.statusCode).toBe(400);
  });

  it('braucht das CSRF-Token', async () => {
    const body = await list();
    const target = body.chapters[0]?.concepts[0];
    const response = await context.app.inject({
      method: 'PATCH',
      url: `/api/concepts/${target?.id}`,
      headers: { cookie: cookieHeader },
      payload: { title: 'Ohne Token' },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('Bestaetigen', () => {
  it('setzt ein einzelnes Konzept auf approved', async () => {
    const body = await list();
    const target = body.chapters[0]?.concepts[0];

    const response = await context.app.inject({
      method: 'POST',
      url: `/api/concepts/${target?.id}/approve`,
      headers: writeHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ approved: 1 });

    const [row] = await context.handle.db
      .select()
      .from(concept)
      .where(eq(concept.id, target?.id as string));
    expect(row?.state).toBe('approved');
  });

  it('bestaetigt ein ganzes Kapitel als Sammelaktion', async () => {
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/concepts/chapters/1/approve',
      headers: writeHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ approved: 3 });
    expect((await list()).totals).toMatchObject({ draft: 0, approved: 3 });
  });

  it('meldet 404 fuer ein unbekanntes Konzept', async () => {
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/concepts/11111111-1111-4111-8111-111111111111/approve',
      headers: writeHeaders(),
    });
    expect(response.statusCode).toBe(404);
  });
});
