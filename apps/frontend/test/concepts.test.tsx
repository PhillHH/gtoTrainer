import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConceptDetail, ConceptListResponse } from '@gto/shared';
import { AUTHENTICATED_ME, jsonResponse, mockFetch, renderApp } from './helpers.js';

/**
 * Review-Ansicht des Konzept-Graphen (AP3.T3.2). Das Netzwerk ist gemockt -
 * geprueft wird die Oberflaeche, nicht das Backend.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

const POT_ODDS: ConceptDetail = {
  id: 'c-1',
  chapterNumber: 1,
  chapterTitle: 'Erste Grundlagen',
  title: 'Pot Odds',
  summary: 'Verhaeltnis von Einsatz zu moeglichem Gewinn.',
  topicArea: 'grundlagen-mathematik',
  minLevel: 'einsteiger',
  state: 'draft',
  origin: 'ai',
  ordinal: 0,
  prerequisites: [],
  unresolvedPrerequisites: [],
  sectionCount: 2,
  chartCount: 1,
};

const ERWARTUNGSWERT: ConceptDetail = {
  ...POT_ODDS,
  id: 'c-2',
  title: 'Erwartungswert',
  summary: 'Durchschnittlicher Ertrag ueber viele Wiederholungen.',
  ordinal: 1,
  prerequisites: [{ id: 'c-1', title: 'Pot Odds' }],
  unresolvedPrerequisites: ['Varianz'],
  sectionCount: 0,
  chartCount: 0,
};

function listResponse(overrides: Partial<ConceptListResponse> = {}): ConceptListResponse {
  return {
    chapters: [
      {
        chapterNumber: 1,
        chapterTitle: 'Erste Grundlagen',
        partNumber: 1,
        concepts: [POT_ODDS, ERWARTUNGSWERT],
      },
      {
        chapterNumber: 2,
        chapterTitle: 'Zweiter Teil',
        partNumber: 1,
        concepts: [],
      },
    ],
    issues: [
      {
        kind: 'unresolved-prerequisite',
        detail: '"Erwartungswert" verweist auf unbekannte Voraussetzungen: Varianz',
        conceptIds: ['c-2'],
      },
      {
        kind: 'chapter-empty',
        detail: 'Kapitel 2 hat kein einziges Konzept.',
        conceptIds: [],
      },
    ],
    topicAreas: [
      { id: 'grundlagen-mathematik', label: 'Grundlagen und Mathematik' },
      { id: 'spieltheorie', label: 'Spieltheorie' },
    ],
    levels: ['einsteiger', 'fortgeschritten', 'experte'],
    totals: { concepts: 2, draft: 2, approved: 0, withoutSection: 1 },
    ...overrides,
  };
}

interface ConceptMock {
  readonly calls: { url: string; method: string; body: string | undefined }[];
}

/** Erweitert den Standard-Mock um die Konzept-Endpunkte. */
function mockConcepts(options: { patchStatus?: number; patchBody?: unknown } = {}): ConceptMock {
  const calls: ConceptMock['calls'] = [];
  let current = listResponse();

  mockFetch({ me: AUTHENTICATED_ME });
  const base = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
  const original = base.getMockImplementation() as (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>;

  base.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();

    if (url.includes('/api/concepts')) {
      calls.push({
        url,
        method,
        body: typeof init?.body === 'string' ? init.body : undefined,
      });

      if (method === 'PATCH') {
        if (options.patchStatus && options.patchStatus >= 400) {
          return jsonResponse(options.patchStatus, options.patchBody);
        }
        return jsonResponse(200, { concept: POT_ODDS });
      }
      if (url.endsWith('/approve')) {
        // Das Backend liefert nach dem Bestaetigen den neuen Zustand.
        current = listResponse({
          chapters: [
            {
              chapterNumber: 1,
              chapterTitle: 'Erste Grundlagen',
              partNumber: 1,
              concepts: [{ ...POT_ODDS, state: 'approved' }, ERWARTUNGSWERT],
            },
            { chapterNumber: 2, chapterTitle: 'Zweiter Teil', partNumber: 1, concepts: [] },
          ],
          totals: { concepts: 2, draft: 1, approved: 1, withoutSection: 1 },
        });
        return jsonResponse(200, { approved: 1 });
      }
      return jsonResponse(200, current);
    }

    return original(input, init);
  });

  return { calls };
}

describe('Konzept-Review: Liste', () => {
  it('rendert die Konzepte nach Kapitel gruppiert', async () => {
    mockConcepts();
    renderApp('/konzepte');

    expect(await screen.findByRole('heading', { name: 'Konzepte' })).toBeInTheDocument();
    expect(
      await screen.findByRole('heading', { name: /Kapitel 1 — Erste Grundlagen/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Pot Odds' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Erwartungswert' })).toBeInTheDocument();
    expect(screen.getByText(/2 Konzepte — 2 offen, 0 bestätigt/)).toBeInTheDocument();
  });

  it('zeigt Zustand, Themenbereich und Voraussetzungen je Konzept', async () => {
    mockConcepts();
    renderApp('/konzepte');

    await screen.findByRole('heading', { name: 'Erwartungswert' });
    expect(screen.getAllByText('offen').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Grundlagen und Mathematik').length).toBeGreaterThan(0);
    expect(screen.getByText(/Pot Odds, Varianz \(unbekannt\)/)).toBeInTheDocument();
  });

  it('zeigt Auffaelligkeiten an', async () => {
    mockConcepts();
    renderApp('/konzepte');

    const panel = await screen.findByRole('region', { name: 'Auffälligkeiten' });
    expect(within(panel).getByText('Offene Voraussetzung')).toBeInTheDocument();
    expect(within(panel).getByText('Kapitel ohne Konzepte')).toBeInTheDocument();
  });

  it('weist ein leeres Kapitel als solches aus', async () => {
    mockConcepts();
    renderApp('/konzepte');

    await screen.findByRole('heading', { name: /Kapitel 2/ });
    expect(screen.getByText('Kein Konzept in diesem Kapitel.')).toBeInTheDocument();
  });
});

describe('Konzept-Review: Bearbeiten', () => {
  it('sendet die geaenderten Daten als PATCH', async () => {
    const mock = mockConcepts();
    const user = userEvent.setup();
    renderApp('/konzepte');

    await screen.findByRole('heading', { name: 'Pot Odds' });
    await user.click(screen.getAllByRole('button', { name: 'Bearbeiten' })[0] as HTMLElement);

    const summary = screen.getByLabelText('Kurzdefinition');
    await user.clear(summary);
    await user.type(summary, 'Neue Definition.');
    await user.selectOptions(screen.getByLabelText('Themenbereich'), 'spieltheorie');
    await user.click(screen.getByRole('button', { name: 'Speichern' }));

    await waitFor(() => {
      const patch = mock.calls.find((call) => call.method === 'PATCH');
      expect(patch).toBeDefined();
      expect(patch?.url).toContain('/api/concepts/c-1');
      expect(JSON.parse(patch?.body ?? '{}')).toMatchObject({
        summary: 'Neue Definition.',
        topicArea: 'spieltheorie',
        title: 'Pot Odds',
      });
    });
  });

  it('zeigt die feldweise Ablehnung des Servers an', async () => {
    mockConcepts({
      patchStatus: 400,
      patchBody: {
        error: 'invalid_concept',
        message: 'Die Änderung wurde abgelehnt.',
        fields: [{ field: 'prerequisiteIds', message: 'würde einen Zyklus schließen.' }],
      },
    });
    const user = userEvent.setup();
    renderApp('/konzepte');

    await screen.findByRole('heading', { name: 'Pot Odds' });
    await user.click(screen.getAllByRole('button', { name: 'Bearbeiten' })[0] as HTMLElement);
    await user.click(screen.getByRole('button', { name: 'Speichern' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Zyklus/);
  });
});

describe('Konzept-Review: Bestaetigen', () => {
  it('setzt ein einzelnes Konzept auf bestaetigt', async () => {
    const mock = mockConcepts();
    const user = userEvent.setup();
    renderApp('/konzepte');

    await screen.findByRole('heading', { name: 'Pot Odds' });
    await user.click(screen.getAllByRole('button', { name: 'Bestätigen' })[0] as HTMLElement);

    await waitFor(() => {
      expect(mock.calls.some((call) => call.url.endsWith('/api/concepts/c-1/approve'))).toBe(true);
    });
    expect(await screen.findByText(/2 Konzepte — 1 offen, 1 bestätigt/)).toBeInTheDocument();
  });

  it('bestaetigt ein ganzes Kapitel als Sammelaktion', async () => {
    const mock = mockConcepts();
    const user = userEvent.setup();
    renderApp('/konzepte');

    await screen.findByRole('heading', { name: /Kapitel 1/ });
    await user.click(
      screen.getAllByRole('button', { name: 'Kapitel bestätigen' })[0] as HTMLElement,
    );

    await waitFor(() => {
      expect(mock.calls.some((call) => call.url.endsWith('/api/concepts/chapters/1/approve'))).toBe(
        true,
      );
    });
    expect(await screen.findByRole('status')).toHaveTextContent(/bestätigt/);
  });
});
