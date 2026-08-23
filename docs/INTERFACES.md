# Schnittstellen & Andockpunkte

Dieses Dokument beschreibt, **wo** sich Komponenten und Arbeitspakete
gegenseitig berühren. Jeder Task trägt seine Deltas hier nach.

Stand: AP1.T1.3.

---

## 1. `packages/shared` — der Vertragsort

Alles, was Backend und Frontend **gemeinsam** kennen müssen (Typen, DTOs,
Konstanten, Type-Guards), lebt in `packages/shared` und **nirgendwo sonst**.

- Paketname: `@gto/shared`
- Einstiegspunkt: `packages/shared/src/index.ts` (re-exportiert alle Verträge)
- Konsumenten binden es als `"@gto/shared": "workspace:*"` ein.

**Regel:** Eine Änderung an einem geteilten Vertrag beginnt in
`packages/shared`, nicht im Backend oder Frontend. Wer einen Typ dupliziert,
statt ihn hier zu importieren, bricht diese Konvention.

### Aktueller Inhalt

| Export                | Art          | Bedeutung                         |
| --------------------- | ------------ | --------------------------------- |
| `HealthResponse`      | `interface`  | Antwortvertrag von `GET /healthz` |
| `HEALTH_STATUS_OK`    | `const 'ok'` | Einziger gültiger Health-Status   |
| `isHealthResponse(v)` | Type-Guard   | Laufzeitprüfung gegen den Vertrag |

---

## 2. HTTP-API des Backends

Basis-URL lokal: `http://localhost:3000` (über `PORT`/`HOST` konfigurierbar).
Im Zielbetrieb hinter dem Host-Nginx (ab T1.5).

### `GET /healthz`

Liveness-Probe des Backends.

- **Request:** keine Parameter, kein Body, keine Authentifizierung.
- **Response:** `200 OK`, `application/json`

```json
{ "status": "ok" }
```

- **Vertrag:** `HealthResponse` aus `@gto/shared`. Das Backend typisiert den
  Handler damit; der Test `apps/backend/test/healthz.test.ts` prüft die echte
  HTTP-Antwort per `isHealthResponse()` gegen denselben Vertrag.
- **Ausblick:** Der Betrieb hinter Nginx (Proxy-Regel, Docker-Healthcheck)
  folgt in **AP1.T1.5**. Die Route selbst bleibt unverändert.

Weitere Endpunkte existieren nach T1.1 nicht.

---

## 2a. Auth-API (AP1.T1.3)

Alle Auth-Endpunkte liegen unter `/api/auth/`. Antwort- und Fehlertypen kommen
aus `@gto/shared` — das Frontend (T1.4) importiert sie von dort und definiert
nichts nach.

### Endpunkte

| Methode | Pfad               | Session nötig | Zweck                                       |
| ------- | ------------------ | ------------- | ------------------------------------------- |
| `GET`   | `/api/auth/csrf`   | nein          | CSRF-Token holen (setzt `gto_csrf`)         |
| `POST`  | `/api/auth/login`  | nein          | Anmelden, setzt `gto_session`               |
| `POST`  | `/api/auth/logout` | nein          | Session serverseitig löschen, Cookie leeren |
| `GET`   | `/api/auth/me`     | **ja**        | Basisdaten des angemeldeten Benutzers       |

#### `POST /api/auth/login`

Body: `LoginRequest` — `{ "username": "…", "password": "…" }`

| Status | Body                                                 | Bedeutung                                                    |
| ------ | ---------------------------------------------------- | ------------------------------------------------------------ |
| `200`  | `LoginResponse` — `{ "user": { "id", "username" } }` | Erfolg; `gto_session` gesetzt                                |
| `400`  | `{ "error": "invalid_request" }`                     | Feld fehlt                                                   |
| `401`  | `{ "error": "invalid_credentials" }`                 | **Identisch** bei falschem Passwort und unbekanntem Benutzer |
| `403`  | `{ "error": "csrf_failed" }`                         | CSRF-Prüfung fehlgeschlagen                                  |
| `429`  | `{ "error": "rate_limited" }` + `Retry-After`        | Zu viele Fehlversuche                                        |

> Die `401`-Antwort ist bei falschem Passwort und unbekanntem Benutzer
> **byte-gleich**, und beide Fälle kosten dieselbe Rechenzeit (Verify gegen
> einen Dummy-Hash). Das Frontend darf daraus nichts ableiten.

### Cookie-Vertrag

| Cookie        | HttpOnly | Inhalt                   | Wer liest es                  |
| ------------- | -------- | ------------------------ | ----------------------------- |
| `gto_session` | **ja**   | Session-Token (Klartext) | nur der Server                |
| `gto_csrf`    | **nein** | CSRF-Token               | der Client (muss es spiegeln) |

Beide mit `Path=/`, `SameSite=Lax` (konfigurierbar) und `Secure` gemäß
`COOKIE_SECURE`. Details und Begründung: [ADR-0008](./DECISIONS.md).

> **Lokal ohne HTTPS muss `COOKIE_SECURE=false` gesetzt sein**, sonst verwirft
> der Browser das Cookie und der Login scheint grundlos zu scheitern.

### CSRF-Ablauf für das Frontend (T1.4)

1. Einmalig (und nach jedem Login) `GET /api/auth/csrf` aufrufen.
2. Den Wert aus dem Body (`csrfToken`) **oder** aus dem lesbaren Cookie
   `gto_csrf` entnehmen.
3. Bei **jedem** `POST`/`PUT`/`PATCH`/`DELETE` als Header
   **`x-csrf-token: <wert>`** mitschicken.
4. Alle Requests mit `credentials: 'include'` senden, damit die Cookies mitgehen.

Fehlt der Header oder passt er nicht zum Cookie: **403 `csrf_failed`**.
Lesende Requests (`GET`/`HEAD`/`OPTIONS`) brauchen kein Token.
Nach erfolgreichem Login setzt der Server ein **frisches** CSRF-Cookie — der
Client sollte den Wert danach neu einlesen.

### Eine neue Route als geschützt markieren

Es gibt **genau eine** Stelle, die über Zugriff entscheidet: den Guard
`app.requireSession` aus `src/auth/plugin.ts`. Folge-APs implementieren keine
eigene Prüfung, sondern hängen sich dort ein:

```ts
app.get('/api/lernen/aufgaben', { preHandler: app.requireSession }, async (request) => {
  // request.sessionUser ist hier garantiert gesetzt
  return ladeAufgaben(request.sessionUser!.id);
});
```

Ohne gültige Session antwortet der Guard mit `401 unauthenticated`.
Der CSRF-Hook greift davon unabhängig **global** für alle zustandsändernden
Methoden — eine neue Route kann ihn nicht versehentlich umgehen.

### Ausnahme: `GET /healthz` bleibt öffentlich

`/healthz` ist **bewusst ohne Session erreichbar** und liegt außerhalb von
`/api/auth/`. Grund: Ab T1.5 rufen der Host-Nginx und der Container-Healthcheck
diesen Endpunkt ohne Anmeldung auf. Er liefert ausschließlich
`{ "status": "ok" }` und keinerlei interne Daten.

### TOTP-Hook — vorbereitet, standardmäßig aus

In T1.3 ist **nur die Einhängestelle** vorhanden, keine TOTP-Prüfung.

| Baustein           | Zustand                                                          |
| ------------------ | ---------------------------------------------------------------- |
| `user.totp_secret` | Spalte existiert seit T1.2, `NULL`                               |
| `TOTP_ENABLED`     | Umgebungsvariable, Default **`false`**                           |
| Einhängestelle     | `src/auth/routes.ts`, Block `TOTP-HOOK` nach der Passwortprüfung |

Verhalten heute: Ist `TOTP_ENABLED=true` **und** hat der Benutzer ein
`totp_secret`, wird der Login **abgelehnt** statt den zweiten Faktor
stillschweigend zu überspringen — ein aktivierter Schalter darf nicht
wirkungslos sein.

Zum späteren Aktivieren sind drei Schritte nötig:

1. TOTP-Verifikation im markierten Block implementieren (`body.totp` gegen
   `user.totp_secret` prüfen).
2. Einen Weg schaffen, das Secret zu setzen (Erweiterung des Passwort-CLI).
3. `TOTP_ENABLED=true` setzen.

---

## 3. Datenbankschema (Basisschema, AP1.T1.2)

Quelle der Wahrheit ist `apps/backend/src/db/schema.ts`. Alles Weitere
(Migrations-SQL, Typen) wird daraus abgeleitet — das Schema wird **nie** direkt
in der Datenbank geändert.

### Namens- und Typkonventionen

| Regel                                             | Begründung                                                                                       |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Tabellennamen **Singular**, `snake_case`          | `user`, nicht `users` — konsistent mit dem Domänenbegriff je Zeile                               |
| Primärschlüssel `uuid` mit `gen_random_uuid()`    | Keine erratbaren, fortlaufenden IDs; seit Postgres 13 ohne Extension verfügbar                   |
| Zeitstempel durchgängig **`timestamptz`**         | `timestamp` ohne Zeitzone führt bei Zeitumstellung und Container-TZ zu falschen Werten           |
| Statusfelder als `text` + **CHECK-Constraint**    | Ein pg-`ENUM` lässt sich nur umständlich erweitern; ein CHECK ändert sich per normaler Migration |
| Strukturierte Werte als **`jsonb`**, nicht `json` | `jsonb` ist indizierbar und normalisiert die Darstellung                                         |

> `user` ist in SQL ein reserviertes Wort. Drizzle quotet den Bezeichner
> automatisch; in rohem SQL muss `"user"` geschrieben werden.

### Die fünf Tabellen

**`user`** — Single-User-Betrieb. Seit T1.3 fachlich in Benutzung (Login,
Passwort-CLI).

| Spalte          | Typ           | Hinweis                                           |
| --------------- | ------------- | ------------------------------------------------- |
| `id`            | `uuid` PK     | `gen_random_uuid()`                               |
| `username`      | `text`        | eindeutig (`user_username_key`)                   |
| `password_hash` | `text`        | argon2id-Hash ([ADR-0007](./DECISIONS.md))        |
| `totp_secret`   | `text` NULL   | TOTP-Hook, standardmäßig aus (siehe Abschnitt 2a) |
| `created_at`    | `timestamptz` | Default `now()`                                   |
| `updated_at`    | `timestamptz` | Default `now()`                                   |

**`session`** — seit T1.3 in Benutzung.

| Spalte         | Typ                | Hinweis                                                                                                                                                                           |
| -------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`           | `uuid` PK          | `gen_random_uuid()`                                                                                                                                                               |
| `token_hash`   | `text`             | eindeutig; **SHA-256 des Session-Tokens**. Der Klartext steht ausschließlich im Cookie, nie in der Datenbank ([ADR-0008](./DECISIONS.md)). Seit Migration `0001` (vorher `token`) |
| `user_id`      | `uuid` FK → `user` | `ON DELETE CASCADE`                                                                                                                                                               |
| `expires_at`   | `timestamptz`      | Index `session_expires_at_idx` fürs Aufräumen                                                                                                                                     |
| `last_seen_at` | `timestamptz` NULL |                                                                                                                                                                                   |
| `created_at`   | `timestamptz`      | Index `session_user_id_idx` auf `user_id`                                                                                                                                         |

**`config`** — Key/Value-Konfiguration zur Laufzeit.

| Spalte       | Typ           | Hinweis                                                                          |
| ------------ | ------------- | -------------------------------------------------------------------------------- |
| `key`        | `text` PK     | z. B. `llm.provider`, `learning.mastery_threshold`                               |
| `value`      | `jsonb`       | `NOT NULL`; „nicht gesetzt" wird als JSON-`null` gespeichert, nicht als SQL NULL |
| `updated_at` | `timestamptz` | Default `now()`                                                                  |

**`llm_call_log`** — Skelett, befüllt wird es in **AP2**.

| Spalte                                               | Typ            | Hinweis                                  |
| ---------------------------------------------------- | -------------- | ---------------------------------------- |
| `id`                                                 | `uuid` PK      |                                          |
| `provider`, `model`                                  | `text`         |                                          |
| `prompt`                                             | `text`         | ohne Längenbegrenzung                    |
| `response`                                           | `text` NULL    | leer, solange der Aufruf läuft           |
| `duration_ms`                                        | `integer` NULL |                                          |
| `prompt_tokens`, `completion_tokens`, `total_tokens` | `integer` NULL |                                          |
| `status`                                             | `text`         | CHECK: `pending` \| `success` \| `error` |
| `error`                                              | `text` NULL    |                                          |
| `created_at`                                         | `timestamptz`  | Index `llm_call_log_created_at_idx`      |

**`job_queue`** — asynchrone Arbeit, genutzt ab AP2.

| Spalte         | Typ                | Hinweis                                                      |
| -------------- | ------------------ | ------------------------------------------------------------ |
| `id`           | `uuid` PK          |                                                              |
| `job_type`     | `text`             |                                                              |
| `payload`      | `jsonb`            | Default `'{}'::jsonb`                                        |
| `status`       | `text`             | CHECK: `queued` \| `running` \| `done` \| `failed` \| `dead` |
| `attempts`     | `integer`          | Default 0                                                    |
| `max_attempts` | `integer`          | Default 3                                                    |
| `available_at` | `timestamptz`      | Default `now()`; steuert Verzögerung und Backoff             |
| `claimed_at`   | `timestamptz` NULL |                                                              |
| `finished_at`  | `timestamptz` NULL |                                                              |
| `last_error`   | `text` NULL        |                                                              |
| `created_at`   | `timestamptz`      |                                                              |

Der zusammengesetzte Index **`job_queue_claim_idx (status, available_at)`**
bedient genau die Claiming-Abfrage
`where status = 'queued' and available_at <= now()`.

---

## 4. Migrations-Workflow — so ergänzen Folge-APs das Schema

1. Tabelle/Spalte in `apps/backend/src/db/schema.ts` ändern.
2. `pnpm db:generate` — `drizzle-kit` schreibt eine **neue, nummerierte**
   SQL-Datei nach `apps/backend/drizzle/`.
3. Die erzeugte SQL-Datei lesen und **mit committen**. Sie ist ab dann
   unveränderlich — Korrekturen erfolgen über eine **weitere** Migration, nie
   durch Editieren einer bereits ausgelieferten Datei.
4. `pnpm db:migrate` spielt offene Migrationen ein. Drizzle führt Buch in
   `drizzle.__drizzle_migrations` und überspringt bereits Angewandtes.

> **Regel:** Migrationen werden **zur Entwicklungszeit** erzeugt und
> versioniert, **niemals zur Laufzeit generiert**. Der Produktivbetrieb spielt
> ausschließlich vorhandene Dateien ein.

Zugehörige Skripte (Root): `db:up`, `db:down`, `db:generate`, `db:migrate`,
`db:seed`, `db:reset`.

---

## 5. `data/book-source/` — Pflicht-Input für AP3

**Verbindlicher Andockpunkt zwischen Nutzer und Ingestion.**

- **Pfad:** `data/book-source/` (Repo-Wurzel)
- **Wer befüllt:** der **Nutzer**, manuell, lokal bzw. auf dem Zielsystem.
- **Wer liest:** die Ingestion aus **AP3** — vorher greift **kein** Code darauf zu.
- **Versionierung:** Inhalt ist git-ignoriert (`data/book-source/*`);
  **nur** `data/book-source/README.md` liegt im Repository.

### Erwarteter Inhalt

| Datei           | Beschreibung                                   |
| --------------- | ---------------------------------------------- |
| `*.md`          | Buch-Volltext als eine Markdown-Datei          |
| `pXXXX_YY.jpeg` | Chart-/Abbildungs-Bilder, flach im Verzeichnis |

`XXXX` = vierstellige Seitenzahl mit führenden Nullen, `YY` = zweistelliger
Zähler der Abbildung auf dieser Seite, beginnend bei `01`.
Beispiel: `p0042_01.jpeg`.

> **Pflicht:** Das Verzeichnis muss **vor dem Start von AP3** vollständig
> befüllt sein. Andernfalls kann AP3 nicht beginnen — es gibt keinen Fallback
> und keine mitgelieferten Beispieldaten.

Details siehe [`data/book-source/README.md`](../data/book-source/README.md).

---

## 6. `docs/ap/` — Kanon der Arbeitspakete

- **Wer schreibt:** ausschließlich der **Nutzer**.
- **Wer liest:** der Coding-Agent, vor jedem Task.
- **Regel:** Der Agent verändert Dateien in `docs/ap/` **niemals**. Weicht ein
  erhaltener Auftrag vom Kanon ab, wird der Task mit `STATUS: BLOCKED`
  abgebrochen. Siehe [AGENT_GUIDE.md](./AGENT_GUIDE.md).

---

## 7. Noch nicht existierende Schnittstellen

| Schnittstelle                                 | Entsteht in |
| --------------------------------------------- | ----------- |
| Datenbankzugriff / Migrationen                | AP1.T1.2    |
| Frontend-API-Client, Routing                  | AP1.T1.4    |
| Nginx-Vhost, Compose-Netzwerk, Backup/Restore | AP1.T1.5    |
| CI-Pipeline, E2E-Tests                        | AP1.T1.6    |
