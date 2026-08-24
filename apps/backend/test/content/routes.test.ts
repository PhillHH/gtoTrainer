import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  ChapterListResponse,
  ChartDetail,
  ChartListResponse,
  ContentConceptDetail,
  ContentConceptListResponse,
  LearningPathResponse,
  SectionDetail,
  SectionListResponse,
} from '@gto/shared';
import { rangeChart, user } from '../../src/db/schema.js';
import { createTestContext, createTestUser, login } from '../auth/helpers.js';
import type { TestContext } from '../auth/helpers.js';
import { MINI_BOOK } from '../book/fixtures.js';
import { clearAll, seedContent } from './helpers.js';
import type { SeededContent } from './helpers.js';

/**
 * Content-API (AP3.T3.5) gegen echte importierte Daten.
 *
 * Das Buch geht durch `importBook` - denselben Weg wie in Produktion. Kein
 * Test in dieser Datei setzt einen KI-Aufruf ab; die API interpretiert nichts.
 */

const USERNAME = 'content-api-user';
const PASSWORD = 'content-api-passwort-lang';

let context: TestContext;
let cookieHeader: string;
let seeded: SeededContent;

beforeAll(async () => {
  context = await createTestContext(undefined, { bookSourceDir: MINI_BOOK });
  await createTestUser(context, USERNAME, PASSWORD);
  cookieHeader = (await login(context.app, USERNAME, PASSWORD)).cookieHeader;
});

afterAll(async () => {
  await context.handle.db.delete(user).where(eq(user.username, USERNAME));
  await context.close();
});

beforeEach(async () => {
  await clearAll(context.handle.db);
  seeded = await seedContent(context.handle.db);
});

/** GET mit Session. */
async function get(
  path: string,
  headers: Record<string, string> = {},
): Promise<{
  statusCode: number;
  headers: Record<string, unknown>;
  body: string;
  json: <T>() => T;
}> {
  const response = await context.app.inject({
    method: 'GET',
    url: path,
    headers: { cookie: cookieHeader, ...headers },
  });
  return {
    statusCode: response.statusCode,
    headers: response.headers as Record<string, unknown>,
    body: response.body,
    json: <T>() => response.json() as T,
  };
}

/* ---------------------------------------------------------------------------
 * Zugriffsschutz
 * ------------------------------------------------------------------------ */

describe('Zugriffsschutz', () => {
  it('liefert ohne Session auf jeder Content-Route 401', async () => {
    const routes = [
      '/api/content/chapters',
      '/api/content/chapters/1/sections',
      '/api/content/sections/ch01/ein-abschnitt',
      '/api/content/concepts',
      '/api/content/concepts/pot-odds',
      '/api/content/concepts/learning-path',
      '/api/content/charts',
      `/api/content/charts/${seeded.approvedChartId}`,
      `/api/content/charts/${seeded.approvedChartId}/cells/AA`,
      '/api/content/spots?position=BN',
    ];
    for (const route of routes) {
      const response = await context.app.inject({ method: 'GET', url: route });
      expect(response.statusCode, route).toBe(401);
    }
  });

  it('liefert einen Bildabruf ohne Session mit 401', async () => {
    const response = await context.app.inject({
      method: 'GET',
      url: `/api/content/assets/${seeded.assetIds['p0003_01.jpeg']}/image`,
    });
    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain('JFIF');
  });
});

/* ---------------------------------------------------------------------------
 * Kapitel und Sektionen
 * ------------------------------------------------------------------------ */

describe('Kapitel und Sektionen', () => {
  it('liefert die Kapitelübersicht mit Zählständen', async () => {
    const response = await get('/api/content/chapters');
    expect(response.statusCode).toBe(200);
    const body = response.json<ChapterListResponse>();

    expect(body.chapters).toHaveLength(3);
    expect(body.chapters[0]).toMatchObject({
      chapterNumber: 1,
      partNumber: 1,
      title: 'Erste Grundlagen',
      sectionCount: 2,
      conceptCount: 2,
    });
    expect(body.totals.sections).toBe(4);
    expect(body.totals.concepts).toBe(4);
  });

  it('liefert in der Kapitelübersicht KEINE Volltexte', async () => {
    const response = await get('/api/content/chapters');
    // Der Fixture-Text steht in book_section.body und darf hier nicht auftauchen.
    expect(response.body).not.toContain('Ein Absatz auf Seite 3');
    expect(response.body).not.toContain('body');
    for (const chapter of response.json<ChapterListResponse>().chapters) {
      expect(Object.keys(chapter)).not.toContain('body');
    }
  });

  it('liefert die Sektionsliste eines Kapitels ohne Volltexte, aber mit bodyChars', async () => {
    const response = await get('/api/content/chapters/1/sections');
    const body = response.json<SectionListResponse>();

    expect(body.chapter.chapterNumber).toBe(1);
    expect(body.sections.map((entry) => entry.sectionKey)).toEqual([
      'ch01/ein-abschnitt',
      'ch01/ein-unterabschnitt',
    ]);
    expect(response.body).not.toContain('Ein Absatz auf Seite 3');
    for (const section of body.sections) {
      expect(Object.keys(section)).not.toContain('body');
      expect(section.bodyChars).toBeGreaterThan(0);
    }
  });

  it('meldet ein unbekanntes Kapitel als not_found statt als leere Liste', async () => {
    const response = await get('/api/content/chapters/99/sections');
    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: string }>().error).toBe('not_found');
  });

  it('liefert das Sektionsdetail mit Volltext, Konzepten und Assets', async () => {
    const response = await get('/api/content/sections/ch01/ein-abschnitt');
    expect(response.statusCode).toBe(200);
    const section = response.json<SectionDetail>();

    expect(section.sectionKey).toBe('ch01/ein-abschnitt');
    expect(section.chapterNumber).toBe(1);
    expect(section.body.length).toBe(section.bodyChars);
    expect(section.concepts.map((entry) => entry.slug)).toEqual(['pot-odds']);

    const asset = section.assets.find((entry) => entry.captionNumber === 1);
    expect(asset?.assetType).toBe('hand_range');
    expect(asset?.imageUrl).toBe(`/api/content/assets/${asset?.id}/image`);
    expect(asset?.chartState).toBe('approved');
  });

  it('findet eine Sektion auch über ihre UUID', async () => {
    const id = seeded.sectionIds['ch01/ein-abschnitt'] as string;
    const response = await get(`/api/content/sections/${id}`);
    expect(response.statusCode).toBe(200);
    expect(response.json<SectionDetail>().sectionKey).toBe('ch01/ein-abschnitt');
  });

  it('ist deutlich schlanker in der Liste als im Detail', async () => {
    const list = await get('/api/content/chapters/1/sections');
    const detail = await get('/api/content/sections/ch01/ein-abschnitt');
    // Der Zuschnitt ist kein Zufall: Wer navigiert, laedt keinen Volltext.
    expect(detail.body.length).toBeGreaterThan(list.body.length / 2);
    expect(list.body).not.toContain('"body"');
    expect(detail.body).toContain('"body"');
  });
});

/* ---------------------------------------------------------------------------
 * Konzepte
 * ------------------------------------------------------------------------ */

describe('Konzepte', () => {
  it('liefert ohne Filter ausschliesslich approved Konzepte', async () => {
    const body = (await get('/api/content/concepts')).json<ContentConceptListResponse>();
    expect(body.concepts.map((entry) => entry.slug)).toEqual([
      'pot-odds',
      'erwartungswert',
      'gleichgewicht',
    ]);
    expect(body.filters.state).toBe('approved');
    expect(body.concepts.some((entry) => entry.slug === 'noch-im-entwurf')).toBe(false);
  });

  it('filtert nach Kapitel, Themenbereich und Level', async () => {
    expect(
      (await get('/api/content/concepts?chapter=1')).json<ContentConceptListResponse>().concepts,
    ).toHaveLength(2);

    expect(
      (await get('/api/content/concepts?topicArea=spieltheorie'))
        .json<ContentConceptListResponse>()
        .concepts.map((entry) => entry.slug),
    ).toEqual(['gleichgewicht']);

    // Ein Level schliesst die darunterliegenden ein.
    expect(
      (await get('/api/content/concepts?level=fortgeschritten'))
        .json<ContentConceptListResponse>()
        .concepts.map((entry) => entry.slug),
    ).toEqual(['pot-odds', 'erwartungswert']);

    expect(
      (await get('/api/content/concepts?state=draft'))
        .json<ContentConceptListResponse>()
        .concepts.map((entry) => entry.slug),
    ).toEqual(['noch-im-entwurf']);
  });

  it('weist einen unbekannten Themenbereich mit der erlaubten Menge zurueck', async () => {
    const response = await get('/api/content/concepts?topicArea=quatsch');
    expect(response.statusCode).toBe(400);
    const body = response.json<{ error: string; allowed: string[] }>();
    expect(body.error).toBe('invalid_request');
    expect(body.allowed).toContain('spieltheorie');
  });

  it('liefert im Konzeptdetail Voraussetzungen in beide Richtungen', async () => {
    const body = (await get('/api/content/concepts/erwartungswert')).json<ContentConceptDetail>();

    expect(body.prerequisites.map((entry) => entry.slug)).toEqual(['pot-odds']);
    expect(body.dependents.map((entry) => entry.slug)).toEqual(['gleichgewicht']);
    expect(body.sections.map((entry) => entry.sectionKey)).toEqual(['ch01/ein-unterabschnitt']);
  });

  it('nennt im Konzeptdetail auch die unaufgeloesten Voraussetzungen', async () => {
    const body = (await get('/api/content/concepts/gleichgewicht')).json<ContentConceptDetail>();
    expect(body.unresolvedPrerequisites).toEqual(['Varianz']);
  });

  it('liefert zum Konzept nur freigegebene Charts', async () => {
    const body = (await get('/api/content/concepts/pot-odds')).json<ContentConceptDetail>();
    expect(body.charts).toHaveLength(1);
    expect(body.charts[0]?.state).toBe('approved');
  });
});

/* ---------------------------------------------------------------------------
 * Lernpfad
 * ------------------------------------------------------------------------ */

describe('Lernpfad', () => {
  it('liefert eine Reihenfolge, in der kein Konzept vor seinen Voraussetzungen steht', async () => {
    const body = (await get('/api/content/concepts/learning-path')).json<LearningPathResponse>();

    const position = new Map(body.steps.map((step) => [step.concept.slug, step.step]));
    expect(body.steps.map((step) => step.concept.slug)).toEqual([
      'pot-odds',
      'erwartungswert',
      'gleichgewicht',
    ]);
    expect(position.get('pot-odds')).toBeLessThan(position.get('erwartungswert') as number);
    expect(position.get('erwartungswert')).toBeLessThan(position.get('gleichgewicht') as number);

    // Die Ebene sagt, was gleichzeitig unterrichtbar waere.
    expect(body.steps.map((step) => step.tier)).toEqual([0, 1, 2]);
    expect(body.cyclic).toEqual([]);
  });

  it('prueft die Ordnung gegen jede Kante des Graphen', async () => {
    const path = (await get('/api/content/concepts/learning-path')).json<LearningPathResponse>();
    const position = new Map(path.steps.map((step) => [step.concept.slug, step.step]));

    for (const step of path.steps) {
      const detail = (
        await get(`/api/content/concepts/${step.concept.slug}`)
      ).json<ContentConceptDetail>();
      for (const prerequisite of detail.prerequisites) {
        const before = position.get(prerequisite.slug);
        if (before === undefined) continue; // ausserhalb der Auswahl
        expect(before, `${prerequisite.slug} vor ${step.concept.slug}`).toBeLessThan(step.step);
      }
    }
  });

  it('blockiert nicht, wenn eine Voraussetzung ausserhalb der Auswahl liegt', async () => {
    // Nur Kapitel 2: "gleichgewicht" setzt "erwartungswert" aus Kapitel 1
    // voraus. Wuerde die ausserhalb liegende Kante zaehlen, waere der Pfad leer.
    const body = (
      await get('/api/content/concepts/learning-path?chapter=2')
    ).json<LearningPathResponse>();
    expect(body.steps.map((step) => step.concept.slug)).toEqual(['gleichgewicht']);
    expect(body.cyclic).toEqual([]);
  });
});

/* ---------------------------------------------------------------------------
 * Charts
 * ------------------------------------------------------------------------ */

describe('Charts', () => {
  it('liefert die Chartliste OHNE Matrizen', async () => {
    const response = await get('/api/content/charts');
    const body = response.json<ChartListResponse>();

    expect(body.charts).toHaveLength(2);
    expect(response.body).not.toContain('"matrix"');
    for (const chart of body.charts) {
      expect(Object.keys(chart)).not.toContain('matrix');
      expect(chart.cellCount).toBe(169);
    }
  });

  it('ist als Liste um ein Vielfaches kleiner als das Detail', async () => {
    const list = await get('/api/content/charts');
    const detail = await get(`/api/content/charts/${seeded.approvedChartId}`);
    // Zwei Charts als Metadaten gegen ein Chart mit 169 Zellen.
    expect(detail.body.length).toBeGreaterThan(list.body.length * 3);
  });

  it('liefert das Chartdetail mit vollstaendiger Matrix und Herkunft', async () => {
    const body = (await get(`/api/content/charts/${seeded.approvedChartId}`)).json<ChartDetail>();

    expect(body.matrix).toHaveLength(169);
    expect(body.matrix[0]?.hand).toBe('AA');
    expect(body.state).toBe('approved');
    expect(body.model).toBe('claude-sonnet-5');
    expect(body.manualCells).toBe(1);
    expect(body.spot).toMatchObject({
      heroPosition: 'BN',
      villainPosition: 'BB',
      stackDepthBb: 25,
    });
    expect(body.imageUrl).toBe(`/api/content/assets/${body.assetId}/image`);

    // Die Gegenprobe aus der Bildunterschrift kommt mit.
    expect(body.captionTotals['raise']).toBeCloseTo(41.5, 5);
  });

  it('filtert die Chartliste nach Kapitel und Konzept', async () => {
    expect(
      (await get('/api/content/charts?chapter=1')).json<ChartListResponse>().charts,
    ).toHaveLength(1);

    const byConcept = (await get('/api/content/charts?concept=pot-odds')).json<ChartListResponse>();
    expect(byConcept.charts).toHaveLength(1);
    expect(byConcept.charts[0]?.id).toBe(seeded.approvedChartId);

    // Ein Konzept ohne Chart liefert eine leere, aber erklaerte Liste.
    const none = (await get('/api/content/charts?concept=gleichgewicht')).json<ChartListResponse>();
    expect(none.charts).toEqual([]);
    expect(none.filters.concept).toBe('gleichgewicht');
  });
});

/* ---------------------------------------------------------------------------
 * Die Approved-Regel
 * ------------------------------------------------------------------------ */

describe('Approved-Regel', () => {
  it('haelt ein nicht freigegebenes Chart aus der normalen Antwort heraus', async () => {
    const normal = (await get('/api/content/charts')).json<ChartListResponse>();
    expect(normal.totals.matched).toBe(2);
    expect(normal.charts.map((entry) => entry.id)).not.toContain(seeded.rawChartId);
    expect(normal.charts.every((entry) => entry.state === 'approved')).toBe(true);
  });

  it('zeigt es nur ueber den ausdruecklichen Review-Parameter', async () => {
    const review = (
      await get('/api/content/charts?includeUnapproved=true')
    ).json<ChartListResponse>();
    expect(review.totals.matched).toBe(3);
    expect(review.charts.map((entry) => entry.id)).toContain(seeded.rawChartId);
    expect(review.filters.includeUnapproved).toBe(true);
  });

  it('verweigert Detail und Zellabruf eines nicht freigegebenen Charts', async () => {
    const detail = await get(`/api/content/charts/${seeded.rawChartId}`);
    expect(detail.statusCode).toBe(404);
    expect(detail.body).toContain('includeUnapproved=true');

    const cell = await get(`/api/content/charts/${seeded.rawChartId}/cells/AA`);
    expect(cell.statusCode).toBe(404);

    // Mit dem Parameter geht beides.
    expect(
      (await get(`/api/content/charts/${seeded.rawChartId}?includeUnapproved=true`)).statusCode,
    ).toBe(200);
    expect(
      (await get(`/api/content/charts/${seeded.rawChartId}/cells/AA?includeUnapproved=true`))
        .statusCode,
    ).toBe(200);
  });

  it('blendet ein zurueckgezogenes Chart sofort aus', async () => {
    await context.handle.db
      .update(rangeChart)
      .set({ state: 'unusable' })
      .where(eq(rangeChart.id, seeded.approvedChartId));

    const body = (await get('/api/content/charts')).json<ChartListResponse>();
    expect(body.charts.map((entry) => entry.id)).not.toContain(seeded.approvedChartId);
    expect((await get(`/api/content/charts/${seeded.approvedChartId}`)).statusCode).toBe(404);
  });

  it('nennt im Sektionsdetail den Chart-Zustand, statt Zahlen zu liefern', async () => {
    // Das Sektionsdetail verweist auf Charts, es liefert keine Frequenzen -
    // die Approved-Regel bleibt damit auf einem Weg.
    const section = (await get('/api/content/sections/ch01/ein-abschnitt')).json<SectionDetail>();
    expect(section.assets.some((entry) => entry.chartId !== null)).toBe(true);
    expect(JSON.stringify(section)).not.toContain('"percent"');
  });
});

/* ---------------------------------------------------------------------------
 * Zellabruf
 * ------------------------------------------------------------------------ */

describe('Zellabruf', () => {
  it('liefert fuer bekannte Blaetter deterministisch den gespeicherten Wert', async () => {
    // Der Fixture-Bestand: Paare und suited/offsuit Asse erhoehen 2.2x,
    // alles andere foldet.
    const cases = [
      { hand: 'AA', kind: 'raise', sizing: '2.2x' },
      { hand: 'AKs', kind: 'raise', sizing: '2.2x' },
      { hand: '72o', kind: 'fold', sizing: null },
      { hand: '22', kind: 'raise', sizing: '2.2x' },
    ] as const;

    for (const entry of cases) {
      const response = await get(
        `/api/content/charts/${seeded.approvedChartId}/cells/${entry.hand}`,
      );
      expect(response.statusCode, entry.hand).toBe(200);
      const cell = response.json<{
        hand: string;
        actions: { kind: string; sizing: string | null; percent: number }[];
        spot: { heroPosition: string | null };
      }>();
      expect(cell.hand).toBe(entry.hand);
      expect(cell.actions).toEqual([{ kind: entry.kind, sizing: entry.sizing, percent: 100 }]);
      // Die Antwort steht fuer sich: der Spot kommt mit.
      expect(cell.spot.heroPosition).toBe('BN');
    }
  });

  it('kennzeichnet eine von Hand korrigierte Zelle', async () => {
    const cell = (await get(`/api/content/charts/${seeded.approvedChartId}/cells/72o`)).json<{
      source: string;
      correctedAt: string | null;
    }>();
    expect(cell.source).toBe('manual');
    expect(cell.correctedAt).not.toBeNull();
  });

  it('laedt eine Zelle statt der ganzen Matrix', async () => {
    const cell = await get(`/api/content/charts/${seeded.approvedChartId}/cells/AA`);
    const full = await get(`/api/content/charts/${seeded.approvedChartId}`);
    expect(cell.body.length).toBeLessThan(full.body.length / 10);
  });

  it('weist eine unsinnige Blattbezeichnung mit einer Erklaerung zurueck', async () => {
    const response = await get(`/api/content/charts/${seeded.approvedChartId}/cells/XYZ`);
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('13×13');
  });
});

/* ---------------------------------------------------------------------------
 * Spot-Suche
 * ------------------------------------------------------------------------ */

describe('Spot-Suche', () => {
  it('findet ueber einen Stacktiefen-Bereich, nicht nur exakt', async () => {
    // 22bb sucht: das 25er-Chart liegt 3bb daneben und passt in die Toleranz.
    const body = (await get('/api/content/spots?position=BN&stack=22')).json<{
      matches: { chart: { id: string }; score: number; matched: string[] }[];
      query: { stackToleranceBb: number };
    }>();

    expect(body.query.stackToleranceBb).toBe(5);
    expect(body.matches).toHaveLength(1);
    expect(body.matches[0]?.chart.id).toBe(seeded.approvedChartId);
    expect(body.matches[0]?.matched).toContain('25bb (3bb daneben)');
    // Nicht exakt heisst: nicht die volle Punktzahl.
    expect(body.matches[0]?.score).toBeLessThan(1);
  });

  it('ordnet den exakten Treffer vor den ungefaehren', async () => {
    const exact = (await get('/api/content/spots?position=BN&stack=25')).json<{
      matches: { score: number }[];
    }>();
    const near = (await get('/api/content/spots?position=BN&stack=22')).json<{
      matches: { score: number }[];
    }>();
    expect(exact.matches[0]?.score).toBe(1);
    expect(exact.matches[0]?.score).toBeGreaterThan(near.matches[0]?.score as number);
  });

  it('findet ueber Position, Gegenposition und Aktion', async () => {
    const body = (await get('/api/content/spots?position=SB&vs=BB&stack=15&action=limp')).json<{
      matches: { chart: { spot: Record<string, unknown> }; matched: string[] }[];
    }>();

    expect(body.matches).toHaveLength(1);
    expect(body.matches[0]?.chart.spot).toMatchObject({
      heroPosition: 'SB',
      villainPosition: 'BB',
      stackDepthBb: 15,
    });
    expect(body.matches[0]?.matched).toEqual(
      expect.arrayContaining(['Position SB', 'gegen BB', '15bb (exakt)']),
    );
  });

  it('erklaert eine leere Antwort mit dem abgedeckten Bereich', async () => {
    const body = (await get('/api/content/spots?position=BN&stack=200')).json<{
      matches: unknown[];
      explanation: string;
      coverage: { stackDepthBb: { min: number; max: number } };
    }>();

    expect(body.matches).toEqual([]);
    expect(body.coverage.stackDepthBb).toEqual({ min: 15, max: 25 });
    expect(body.explanation).toContain('außerhalb des abgedeckten Bereichs');
    expect(body.explanation).toContain('15');
  });

  it('weist auf einen nur schwachen Treffer ausdruecklich hin', async () => {
    // Das SB-Chart ist ein MTT-Spot gegen BB. Wer SB gegen BN im Cash-Spiel
    // sucht, bekommt es trotzdem - die Position stimmt ja -, aber mit einem
    // Hinweis statt einer stillen Zustimmung.
    const body = (await get('/api/content/spots?position=SB&vs=BN&format=cash')).json<{
      matches: { score: number; missed: string[] }[];
      explanation: string;
    }>();
    expect(body.matches).toHaveLength(1);
    expect(body.matches[0]?.score).toBeLessThan(0.75);
    expect(body.explanation).toContain('Übereinstimmung');
    expect(body.explanation).toContain('Gegenposition BB statt BN');
    expect(body.explanation).toContain('Spielform mtt statt cash');
  });

  it('erklaert eine Position, fuer die nichts freigegeben ist', async () => {
    const body = (await get('/api/content/spots?position=UTG')).json<{
      matches: unknown[];
      explanation: string;
    }>();
    expect(body.matches).toEqual([]);
    expect(body.explanation).toContain('Für die Position UTG ist kein Chart freigegeben');
    expect(body.explanation).toContain('BN');
  });

  it('durchsucht nur freigegebene Charts', async () => {
    // Das raw-Chart steht ebenfalls auf BN/25bb. Ohne die Approved-Regel
    // waeren es zwei Treffer.
    const normal = (await get('/api/content/spots?position=BN&stack=25')).json<{
      matches: unknown[];
      coverage: { chartsSearched: number };
    }>();
    expect(normal.matches).toHaveLength(1);
    expect(normal.coverage.chartsSearched).toBe(2);

    const review = (
      await get('/api/content/spots?position=BN&stack=25&includeUnapproved=true')
    ).json<{ matches: unknown[] }>();
    expect(review.matches).toHaveLength(2);
  });

  it('weist eine unbekannte Position mit der erlaubten Menge zurueck', async () => {
    const response = await get('/api/content/spots?position=Knopf');
    expect(response.statusCode).toBe(400);
    expect(response.json<{ allowed: string[] }>().allowed).toContain('BN');
  });
});
