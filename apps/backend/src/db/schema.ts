import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Basisschema (AP1.T1.2) - bewusst schlankes Skelett.
 *
 * Konventionen:
 * - Tabellen- und Spaltennamen in snake_case, Tabellennamen im Singular.
 * - Primaerschluessel durchgaengig `uuid` mit `gen_random_uuid()` (pgcrypto ist
 *   in Postgres 16 als Erweiterung verfuegbar; `gen_random_uuid()` ist seit
 *   Postgres 13 im Core enthalten).
 * - Alle Zeitstempel `timestamptz` - niemals `timestamp` ohne Zeitzone.
 * - Statuswerte als `text` mit CHECK-Constraint statt pg-ENUM: neue Werte
 *   lassen sich per Migration aendern, ohne einen Enum-Typ umbauen zu muessen.
 */

/** Zeitstempel-Spalten, die praktisch jede Tabelle braucht. */
const createdAt = timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

/**
 * Benutzer. Das Projekt ist Single-User-Betrieb; die Tabelle existiert hier
 * nur als Schema. Login, Passwort-Hashing und Sessions folgen in AP1.T1.3.
 *
 * `user` ist in SQL ein reserviertes Wort - Drizzle quotet den Bezeichner,
 * in rohem SQL muss er als "user" geschrieben werden.
 */
export const user = pgTable(
  'user',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    username: text('username').notNull(),
    /** Argon2-Hash. Das Erzeugen des Hashes ist AP1.T1.3, nicht dieser Task. */
    passwordHash: text('password_hash').notNull(),
    /** Base32-TOTP-Secret. Nullable: der TOTP-Hook ist in T1.3 defaultmaessig aus. */
    totpSecret: text('totp_secret'),
    createdAt,
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('user_username_key').on(table.username)],
);

/**
 * Sessions.
 *
 * In der Datenbank steht ausschliesslich der **Hash** des Session-Tokens
 * (`token_hash`). Der Klartext-Token existiert nur im Cookie des Clients. Wer
 * die Datenbank liest, kann daraus keine gueltige Session herstellen.
 */
export const session = pgTable(
  'session',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /**
     * SHA-256 des Klartext-Tokens, hex-kodiert. Niemals der Token selbst.
     * Siehe `src/auth/session.ts`.
     */
    tokenHash: text('token_hash').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    createdAt,
  },
  (table) => [
    uniqueIndex('session_token_hash_key').on(table.tokenHash),
    index('session_user_id_idx').on(table.userId),
    // Fuer das Aufraeumen abgelaufener Sessions.
    index('session_expires_at_idx').on(table.expiresAt),
  ],
);

/**
 * Laufzeit-Konfiguration als Key/Value. Wird ab AP2 z. B. fuer Modellwahl,
 * Provider und Mastery-Schwelle genutzt. `value` ist JSONB, damit Skalare,
 * Objekte und Listen ohne Schemaaenderung abgelegt werden koennen.
 */
export const config = pgTable('config', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Zulaessige Werte fuer `llm_call_log.status`. */
export const LLM_CALL_STATUSES = ['pending', 'success', 'error'] as const;

/**
 * Protokoll der LLM-Aufrufe. Skelett - befuellt wird es in AP2.
 * `prompt`/`response` sind `text` ohne Laengenbegrenzung.
 */
export const llmCallLog = pgTable(
  'llm_call_log',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    prompt: text('prompt').notNull(),
    response: text('response'),
    durationMs: integer('duration_ms'),
    promptTokens: integer('prompt_tokens'),
    completionTokens: integer('completion_tokens'),
    totalTokens: integer('total_tokens'),
    status: text('status').notNull().default('pending'),
    error: text('error'),
    createdAt,
  },
  (table) => [
    index('llm_call_log_created_at_idx').on(table.createdAt),
    check('llm_call_log_status_check', sql`${table.status} in ('pending', 'success', 'error')`),
  ],
);

/** Zulaessige Werte fuer `job_queue.status`. */
export const JOB_STATUSES = ['queued', 'running', 'done', 'failed', 'dead'] as const;

/**
 * Job-Queue fuer asynchrone Arbeit (ab AP2 genutzt).
 *
 * `available_at` steuert Verzoegerung und Backoff: Ein Worker beansprucht den
 * aeltesten Job mit `status = 'queued' AND available_at <= now()`. Genau dafuer
 * existiert der zusammengesetzte Index (status, available_at).
 */
export const jobQueue = pgTable(
  'job_queue',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    jobType: text('job_type').notNull(),
    payload: jsonb('payload')
      .notNull()
      .default(sql`'{}'::jsonb`),
    status: text('status').notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt,
  },
  (table) => [
    index('job_queue_claim_idx').on(table.status, table.availableAt),
    check(
      'job_queue_status_check',
      sql`${table.status} in ('queued', 'running', 'done', 'failed', 'dead')`,
    ),
  ],
);

/** Alle Tabellen des Basisschemas - u. a. von den Tests genutzt. */
export const BASE_TABLES = ['user', 'session', 'config', 'llm_call_log', 'job_queue'] as const;

/* -------------------------------------------------------------------------
 * Buch-Wissensbasis (AP3.T3.1)
 *
 * Drei Tabellen bilden die Buchquelle ab: Kapitel, Sektionen, Assets.
 *
 * Gemeinsame Bauprinzipien:
 * - Jede Tabelle traegt einen **fachlichen Schluessel** (`chapter_number`,
 *   `section_key`, `relative_path`) mit Unique-Index. Der Re-Import findet
 *   Zeilen darueber wieder und aktualisiert sie, statt sie zu loeschen und neu
 *   anzulegen - die `id` bleibt stabil, damit die Chart-Daten aus T3.3/T3.4
 *   dauerhaft am selben Asset haengen.
 * - `content_hash` haelt den Inhaltsstand fest. Ist er gleich, ruehrt der
 *   Import die Zeile nicht an (auch `updated_at` bleibt stehen).
 * - `removed_at` statt DELETE: Quellen, die verschwunden sind, werden
 *   markiert, nicht weggeworfen. Nachgelagerte Daten bleiben erhalten und der
 *   Wegfall ist im Report sichtbar.
 * ---------------------------------------------------------------------- */

/**
 * Zulaessige Werte fuer `book_asset.asset_type` bzw.
 * `book_asset.classification_confidence`.
 *
 * Bewusst hier dupliziert statt aus `@gto/shared` importiert: drizzle-kit
 * buendelt `schema.ts` mit esbuild im CJS-Modus und kann die `exports`-Angabe
 * des Workspace-Pakets dabei nicht aufloesen. Ein Test in
 * `test/book/schema.test.ts` haelt beide Listen deckungsgleich - dieselbe
 * Handhabung wie bei `LLM_CALL_STATUSES` und `JOB_STATUSES`.
 */
export const BOOK_ASSET_TYPES = ['hand_range', 'table', 'diagram', 'formula', 'other'] as const;
export const BOOK_ASSET_CONFIDENCES = ['certain', 'uncertain'] as const;

/** Formt eine Werteliste zu einer SQL-IN-Liste: `'a', 'b'`. */
function sqlList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

/** Kapitel des Buches, inklusive Teil (Part). */
export const bookChapter = pgTable(
  'book_chapter',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /** Nummer des Teils (1-3). */
    partNumber: integer('part_number').notNull(),
    /** Titel des Teils, z. B. "The Elements of Poker Theory". */
    partTitle: text('part_title').notNull(),
    /** Kapitelnummer 1-14 - fachlicher Schluessel. */
    chapterNumber: integer('chapter_number').notNull(),
    title: text('title').notNull(),
    /** Reihenfolge im Buch (0-basiert). */
    ordinal: integer('ordinal').notNull(),
    pageStart: integer('page_start'),
    pageEnd: integer('page_end'),
    contentHash: text('content_hash').notNull(),
    removedAt: timestamp('removed_at', { withTimezone: true }),
    createdAt,
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('book_chapter_number_key').on(table.chapterNumber),
    index('book_chapter_part_idx').on(table.partNumber, table.chapterNumber),
  ],
);

/**
 * Abschnitt eines Kapitels mit Volltext.
 *
 * Der Zuschnitt ist bewusst feingliedrig (jede Ueberschrift eine Zeile): Ab
 * AP5 werden **einzelne Sektionen** gezielt geladen, nicht ganze Kapitel.
 */
export const bookSection = pgTable(
  'book_section',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    chapterId: uuid('chapter_id')
      .notNull()
      .references(() => bookChapter.id, { onDelete: 'cascade' }),
    /** Fachlicher Schluessel, z. B. `ch07/small-blind-pfi-strategy`. */
    sectionKey: text('section_key').notNull(),
    title: text('title').notNull(),
    /** Ueberschriftsebene aus der Quelle (1-6). */
    level: integer('level').notNull(),
    /** Reihenfolge innerhalb des Kapitels (0-basiert). */
    ordinal: integer('ordinal').notNull(),
    /** Volltext des Abschnitts, unveraendert aus der Quelle. */
    body: text('body').notNull(),
    pageStart: integer('page_start'),
    pageEnd: integer('page_end'),
    contentHash: text('content_hash').notNull(),
    removedAt: timestamp('removed_at', { withTimezone: true }),
    createdAt,
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('book_section_key_key').on(table.sectionKey),
    index('book_section_chapter_idx').on(table.chapterId, table.ordinal),
  ],
);

/**
 * Bildasset aus dem Buch mit Unterschrift und Typisierung.
 *
 * `asset_type` ist der Filter fuer T3.3: durch die Vision-Pipeline laufen
 * ausschliesslich Zeilen mit `asset_type = 'hand_range'`.
 */
export const bookAsset = pgTable(
  'book_asset',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /** Pfad relativ zur Wurzel der Buchquelle - fachlicher Schluessel. */
    relativePath: text('relative_path').notNull(),
    fileName: text('file_name').notNull(),
    /** Sektion, in der das Bild steht; NULL im Vorspann des Buches. */
    sectionId: uuid('section_id').references(() => bookSection.id, { onDelete: 'set null' }),
    page: integer('page'),
    /** Zaehler der Abbildung auf der Seite (aus dem Dateinamen). */
    indexOnPage: integer('index_on_page'),
    /** Rohtext der Unterschrift, verlustfrei - Gegenprobe fuer T3.4. */
    captionRaw: text('caption_raw'),
    /** Erkanntes Etikett, z. B. `Hand Range`. */
    captionLabel: text('caption_label'),
    /** Erkannte Nummer, z. B. 96. */
    captionNumber: integer('caption_number'),
    /** Spot-Beschreibung aus der Unterschrift. */
    captionSpot: text('caption_spot'),
    /** Aktions-Prozente als `[{ action, percent }]`. */
    captionActions: jsonb('caption_actions')
      .notNull()
      .default(sql`'[]'::jsonb`),
    assetType: text('asset_type').notNull(),
    /** `certain` oder `uncertain` - unsichere Faelle fallen im Report auf. */
    classificationConfidence: text('classification_confidence').notNull(),
    /** Name der Regel, die den Typ gesetzt hat (siehe src/book/classify.ts). */
    classificationRule: text('classification_rule').notNull(),
    /** Liegt die referenzierte Bilddatei tatsaechlich vor? */
    filePresent: boolean('file_present').notNull().default(true),
    /** Reihenfolge im Buch (0-basiert). */
    ordinal: integer('ordinal').notNull(),
    contentHash: text('content_hash').notNull(),
    removedAt: timestamp('removed_at', { withTimezone: true }),
    createdAt,
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('book_asset_path_key').on(table.relativePath),
    index('book_asset_type_idx').on(table.assetType, table.ordinal),
    index('book_asset_section_idx').on(table.sectionId),
    // Die zulaessigen Werte stammen aus dem Vertrag in `packages/shared`; sie
    // stehen damit genau einmal im Projekt.
    check('book_asset_type_check', sql.raw(`asset_type in (${sqlList(BOOK_ASSET_TYPES)})`)),
    check(
      'book_asset_confidence_check',
      sql.raw(`classification_confidence in (${sqlList(BOOK_ASSET_CONFIDENCES)})`),
    ),
  ],
);

/** Tabellen der Buch-Wissensbasis (AP3.T3.1). */
export const BOOK_TABLES = ['book_chapter', 'book_section', 'book_asset'] as const;

/* -------------------------------------------------------------------------
 * Konzept-Graph (AP3.T3.2)
 *
 * Vier Tabellen: die Konzepte selbst und drei Verknuepfungstabellen
 * (Voraussetzungen, Sektionen, Charts).
 *
 * Invarianten, die das Schema selbst durchsetzt:
 * - `topic_area` und `min_level` stammen aus festen Listen (CHECK).
 * - Eine Voraussetzungskante zeigt nie auf sich selbst (CHECK).
 * - Jede Kante existiert hoechstens einmal (Primaerschluessel ueber beide
 *   Spalten).
 * Was das Schema NICHT durchsetzen kann, ist die Zyklenfreiheit - das prueft
 * `src/concept/graph.ts` und meldet Befunde in die Review-Ansicht.
 *
 * Die Listen sind - wie bei den Buchtabellen - dupliziert, weil drizzle-kit
 * das Workspace-Paket beim Buendeln nicht aufloest;
 * `test/concept/schema.test.ts` haelt sie mit `packages/shared` deckungsgleich.
 * ---------------------------------------------------------------------- */

export const CONCEPT_TOPIC_AREAS = [
  'grundlagen-mathematik',
  'spieltheorie',
  'software-werkzeuge',
  'preflop-ranges',
  'preflop-verteidigung',
  'spiel-gegen-3bets',
  'turnier-metriken-icm',
  'postflop-grundlagen',
  'flop-spiel',
  'turn-spiel',
  'river-spiel',
  'mental-game',
] as const;

export const CONCEPT_LEVELS = ['einsteiger', 'fortgeschritten', 'experte'] as const;
export const CONCEPT_STATES = ['draft', 'approved'] as const;
export const CONCEPT_ORIGINS = ['ai', 'manual'] as const;

/**
 * Fachliche Lerneinheit. Nicht eine Gliederungsueberschrift des Buches -
 * etwas, das man verstehen, anwenden und pruefen kann.
 */
export const concept = pgTable(
  'concept',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    chapterId: uuid('chapter_id')
      .notNull()
      .references(() => bookChapter.id, { onDelete: 'cascade' }),
    /**
     * Fachlicher Schluessel: normalisierter Titel. Traegt die
     * Dubletten-Erkennung ueber Kapitelgrenzen hinweg - derselbe Begriff wird
     * kein zweites Mal angelegt, sondern um Sektionen ergaenzt.
     */
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    /** Knappe, pruefbare Definition. Ohne Frequenzen - die stehen in den Charts. */
    summary: text('summary').notNull(),
    topicArea: text('topic_area').notNull(),
    minLevel: text('min_level').notNull(),
    state: text('state').notNull().default('draft'),
    origin: text('origin').notNull().default('ai'),
    /** Reihenfolge innerhalb des Kapitels. */
    ordinal: integer('ordinal').notNull(),
    /**
     * Voraussetzungen, die als Titel vorgeschlagen wurden, aber auf kein
     * bekanntes Konzept zeigen. Bewusst aufbewahrt statt verworfen: In der
     * Review-Ansicht sind sie offene Punkte, keine stille Luecke.
     */
    unresolvedPrerequisites: jsonb('unresolved_prerequisites')
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt,
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('concept_slug_key').on(table.slug),
    index('concept_chapter_idx').on(table.chapterId, table.ordinal),
    index('concept_topic_area_idx').on(table.topicArea),
    index('concept_state_idx').on(table.state),
    check('concept_topic_area_check', sql.raw(`topic_area in (${sqlList(CONCEPT_TOPIC_AREAS)})`)),
    check('concept_min_level_check', sql.raw(`min_level in (${sqlList(CONCEPT_LEVELS)})`)),
    check('concept_state_check', sql.raw(`state in (${sqlList(CONCEPT_STATES)})`)),
    check('concept_origin_check', sql.raw(`origin in (${sqlList(CONCEPT_ORIGINS)})`)),
  ],
);

/**
 * Gerichtete Kante: `prerequisite_id` muss vor `concept_id` verstanden sein.
 *
 * Die Zyklenfreiheit ist eine Eigenschaft des ganzen Graphen und laesst sich
 * nicht als Constraint ausdruecken - sie wird geprueft, nicht erzwungen.
 */
export const conceptPrerequisite = pgTable(
  'concept_prerequisite',
  {
    conceptId: uuid('concept_id')
      .notNull()
      .references(() => concept.id, { onDelete: 'cascade' }),
    prerequisiteId: uuid('prerequisite_id')
      .notNull()
      .references(() => concept.id, { onDelete: 'cascade' }),
    createdAt,
  },
  (table) => [
    primaryKey({ columns: [table.conceptId, table.prerequisiteId] }),
    index('concept_prerequisite_prereq_idx').on(table.prerequisiteId),
    check('concept_prerequisite_no_self_check', sql`${table.conceptId} <> ${table.prerequisiteId}`),
  ],
);

/**
 * Konzept ↔ Buchsektion. Mehrfach moeglich.
 *
 * Das ist die Grundlage dafuer, dass AP5 gezielt **den richtigen** Buchtext
 * laedt, statt ein ganzes Kapitel in den Kontext zu schieben.
 */
export const conceptSection = pgTable(
  'concept_section',
  {
    conceptId: uuid('concept_id')
      .notNull()
      .references(() => concept.id, { onDelete: 'cascade' }),
    sectionId: uuid('section_id')
      .notNull()
      .references(() => bookSection.id, { onDelete: 'cascade' }),
    createdAt,
  },
  (table) => [
    primaryKey({ columns: [table.conceptId, table.sectionId] }),
    index('concept_section_section_idx').on(table.sectionId),
  ],
);

/**
 * Konzept ↔ `hand_range`-Asset. Zunaechst grob ueber die Sektion abgeleitet;
 * T3.3/T3.4 verfeinern die Zuordnung mit den dann vorhandenen Spot-Metadaten.
 */
export const conceptChart = pgTable(
  'concept_chart',
  {
    conceptId: uuid('concept_id')
      .notNull()
      .references(() => concept.id, { onDelete: 'cascade' }),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => bookAsset.id, { onDelete: 'cascade' }),
    /** Wie die Zuordnung zustande kam, z. B. `section`. */
    source: text('source').notNull().default('section'),
    createdAt,
  },
  (table) => [
    primaryKey({ columns: [table.conceptId, table.assetId] }),
    index('concept_chart_asset_idx').on(table.assetId),
  ],
);

/** Tabellen des Konzept-Graphen (AP3.T3.2). */
export const CONCEPT_TABLES = [
  'concept',
  'concept_prerequisite',
  'concept_section',
  'concept_chart',
] as const;

/* -------------------------------------------------------------------------
 * Chart-Daten (AP3.T3.3)
 *
 * Zwei Tabellen: der Chart-Datensatz und seine Zellen.
 *
 * Warum die Zellen eine eigene Tabelle bekommen und nicht als ein JSON-Blob am
 * Chart haengen: Die Spot-Suche aus T3.5 und die Drills aus AP7 fragen gezielt
 * nach einzelnen Blaettern ("was macht AJs hier?"). Mit einer eigenen Tabelle
 * beantwortet das ein Index; mit einem Blob muesste jedes Mal das ganze Chart
 * geladen und geparst werden.
 *
 * Die zulaessigen Werte sind - wie bei den Buch- und Konzepttabellen -
 * dupliziert, weil drizzle-kit das Workspace-Paket beim Buendeln nicht
 * aufloest; `test/chart/schema.test.ts` haelt sie mit `packages/shared`
 * deckungsgleich.
 * ---------------------------------------------------------------------- */

export const CHART_STATES = ['raw', 'validated', 'approved', 'failed'] as const;

export const CHART_ACTION_KINDS = [
  'fold',
  'check',
  'call',
  'limp',
  'bet',
  'raise',
  'three_bet',
  'four_bet',
  'five_bet',
  'all_in',
] as const;

/**
 * Ein digitalisiertes Range-Chart.
 *
 * Genau eines je `book_asset` - deshalb ist `asset_id` eindeutig. Ein erneuter
 * Lauf ueberschreibt den Datensatz, statt einen zweiten anzulegen; die
 * Wiederaufnahme ueberspringt vorhandene Charts ganz.
 */
export const rangeChart = pgTable(
  'range_chart',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => bookAsset.id, { onDelete: 'cascade' }),
    /** `raw` bis T3.4 die Pruefungen gefahren hat. Nur `approved` ist ab T3.5 sichtbar. */
    state: text('state').notNull().default('raw'),
    /** Modell, das die Matrix gelesen hat - Herkunftsnachweis. */
    model: text('model').notNull(),
    /** Kennung des Laufs, in dem der Datensatz entstand. */
    runId: text('run_id').notNull(),
    /** Legende: die Aktionen, die in diesem Chart vorkommen. */
    actions: jsonb('actions')
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Deterministisch aus der Bildunterschrift gelesener Spot. */
    spot: jsonb('spot')
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** Vom Modell gemeldete unsichere Bereiche - ehrliche Luecken. */
    uncertain: jsonb('uncertain')
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Anzahl gelesener Zellen. 169 = vollstaendig. */
    cellCount: integer('cell_count').notNull().default(0),
    /** Grund, wenn `state = 'failed'`. */
    failureReason: text('failure_reason'),
    durationMs: integer('duration_ms'),
    promptTokens: integer('prompt_tokens'),
    completionTokens: integer('completion_tokens'),
    totalTokens: integer('total_tokens'),
    createdAt,
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('range_chart_asset_key').on(table.assetId),
    index('range_chart_state_idx').on(table.state),
    index('range_chart_run_idx').on(table.runId),
    check('range_chart_state_check', sql.raw(`state in (${sqlList(CHART_STATES)})`)),
  ],
);

/**
 * Eine Zelle der 13x13-Matrix: ein Blatt, eine Aktion, ein Prozentwert.
 *
 * Eine Zelle mit Mischfrequenz erzeugt mehrere Zeilen - je Aktion eine. Der
 * Primaerschluessel schliesst dieselbe Aktion zweimal am selben Blatt aus.
 */
export const rangeChartCell = pgTable(
  'range_chart_cell',
  {
    chartId: uuid('chart_id')
      .notNull()
      .references(() => rangeChart.id, { onDelete: 'cascade' }),
    /** Blatt in ueblicher Notation: `AA`, `AKs`, `AKo`. */
    hand: text('hand').notNull(),
    actionKind: text('action_kind').notNull(),
    /** Groessenangabe, leer wenn ohne. Teil des Schluessels, deshalb nicht NULL. */
    sizing: text('sizing').notNull().default(''),
    /** Anteil in Prozent, 0-100. */
    percent: doublePrecision('percent').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.chartId, table.hand, table.actionKind, table.sizing] }),
    index('range_chart_cell_hand_idx').on(table.hand, table.actionKind),
    check(
      'range_chart_cell_kind_check',
      sql.raw(`action_kind in (${sqlList(CHART_ACTION_KINDS)})`),
    ),
    check('range_chart_cell_percent_check', sql`${table.percent} >= 0 and ${table.percent} <= 100`),
  ],
);

/** Tabellen der Chart-Digitalisierung (AP3.T3.3). */
export const CHART_TABLES = ['range_chart', 'range_chart_cell'] as const;
