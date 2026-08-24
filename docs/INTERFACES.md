# Schnittstellen & Andockpunkte

Dieses Dokument beschreibt, **wo** sich Komponenten und Arbeitspakete
gegenseitig berühren. Jeder Task trägt seine Deltas hier nach.

Stand: AP2.T2.6 — AP2 abgeschlossen.

---

## 1. `packages/shared` — der Vertragsort

Alles, was Backend und Frontend **gemeinsam** kennen müssen (Typen, DTOs,
Konstanten, Type-Guards), lebt in `packages/shared` und **nirgendwo sonst**.

- Paketname: `@gto/shared`
- Einstiegspunkt: `packages/shared/src/index.ts` (re-exportiert alle Verträge)
- Konsumenten binden es als `"@gto/shared": "workspace:*"` ein — seit T1.4
  sowohl `apps/backend` als auch `apps/frontend`.

**Regel:** Eine Änderung an einem geteilten Vertrag beginnt in
`packages/shared`, nicht im Backend oder Frontend. Wer einen Typ dupliziert,
statt ihn hier zu importieren, bricht diese Konvention.

### Aktueller Inhalt

| Export                | Art          | Bedeutung                         |
| --------------------- | ------------ | --------------------------------- |
| `HealthResponse`      | `interface`  | Antwortvertrag von `GET /healthz` |
| `HEALTH_STATUS_OK`    | `const 'ok'` | Einziger gültiger Health-Status   |
| `isHealthResponse(v)` | Type-Guard   | Laufzeitprüfung gegen den Vertrag |
| Auth-Verträge         | s. 2a        | Login, Session, CSRF              |
| `LLMProvider` u. a.   | s. 8         | Vertrag des LLM-Gateways (AP2)    |

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
aus `@gto/shared`; das Frontend importiert sie seit T1.4 von dort und
definiert nichts nach. Wie das Frontend die Endpunkte anspricht, steht in
Abschnitt 2b.

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

## 2b. Frontend-Zugang zum Backend (AP1.T1.4)

### Der API-Client ist die einzige Zugangsstelle

Alle Backend-Aufrufe laufen über `apps/frontend/src/api/client.ts`. **Kein
anderes Modul im Frontend verwendet `fetch`.** Dort sitzen an einem Ort:
Basis-URL, `credentials: 'include'`, der CSRF-Ablauf und die Fehlerauswertung.

Einen neuen Endpunkt anbinden:

```ts
// in src/api/client.ts
export function ladeAufgaben(): Promise<AufgabenResponse> {
  return request<AufgabenResponse>('/api/lernen/aufgaben');
}
```

Die Antworttypen kommen aus `@gto/shared` — im Frontend wird **nichts
nachdefiniert**, was dort bereits als Vertrag existiert.

### Fehlerarten

Der Client wirft ausschließlich `ApiError` mit einem typisierten `kind`:

| `kind`            | Auslöser             | Umgang im UI                                |
| ----------------- | -------------------- | ------------------------------------------- |
| `unauthenticated` | HTTP 401             | Auth-Zustand leeren, Umleitung auf `/login` |
| `rate_limited`    | HTTP 429             | Eigene Meldung („zu viele Fehlversuche")    |
| `csrf_failed`     | HTTP 403             | Hinweis, die Seite neu zu laden             |
| `client`          | sonstige 4xx         | Meldung des Backends anzeigen               |
| `server`          | 5xx                  | allgemeine Fehlermeldung                    |
| `network`         | `fetch` schlägt fehl | „Backend nicht erreichbar"                  |

### Basis-URL

`VITE_API_BASE_URL`, Default **leer** = gleiche Herkunft. Im Dev-Betrieb leitet
der Vite-Proxy `/api` und `/healthz` an das Backend weiter, im Zielbetrieb
(T1.5) der Host-Nginx. Deshalb ist kein CORS nötig
([ADR-0015](./DECISIONS.md)).

### Eine neue geschützte Seite ergänzen

1. Komponente unter `src/pages/` anlegen.
2. In `src/App.tsx` als `<Route>` **unterhalb von `<RequireAuth>`** eintragen —
   der Schutz gilt damit automatisch, eine eigene Prüfung ist weder nötig noch
   erwünscht.
3. Für einen Eintrag in der Seitenleiste `NAV_ITEMS` in
   `src/layout/AppLayout.tsx` ergänzen.

```tsx
<Route element={<RequireAuth />}>
  <Route element={<AppLayout />}>
    <Route path="/neue-seite" element={<NeueSeite />} />
  </Route>
</Route>
```

Öffentliche Seiten kommen **außerhalb** von `<RequireAuth>` — aktuell nur
`/login`.

### Design-Tokens verwenden

Alle visuellen Werte stehen als CSS Custom Properties in
`src/styles/tokens.css`, je einmal für hell und dunkel. **Komponenten
verwenden ausschließlich diese Tokens; hartkodierte Farbwerte sind nicht
zulässig.**

```css
.meine-komponente {
  padding: var(--space-4);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  color: var(--color-text);
  border: var(--border-width) solid var(--color-border);
}
```

| Gruppe     | Beispiele                                                                                                 |
| ---------- | --------------------------------------------------------------------------------------------------------- |
| Farbe      | `--color-bg`, `--color-surface`, `--color-text`, `--color-text-muted`, `--color-accent`, `--color-danger` |
| Abstand    | `--space-1` … `--space-8`                                                                                 |
| Radius     | `--radius-sm/md/lg/full`                                                                                  |
| Typografie | `--font-sans`, `--font-size-xs` … `--font-size-2xl`, `--font-weight-*`                                    |

Wird eine neue Farbe gebraucht, wird sie in **beiden** Sets ergänzt. Für
Wiederverwendbares gibt es fertige Klassen in `global.css`
(`.button`, `.card`, `.field`, `.alert`, `.badge`, `.muted`).

Der Modus hängt an `data-theme` am `<html>`-Element; Startwert ist
`prefers-color-scheme`, eine manuelle Wahl liegt in `localStorage`
(`gto.theme`) — die **einzige** erlaubte Verwendung von `localStorage`.

---

## 2c. Deployment-Schnittstellen (AP1.T1.5)

### Was nach außen liegt

Öffentlich erreichbar ist **ausschließlich der Host-Nginx** auf 80/443. Alle
Container-Ports sind an `127.0.0.1` gebunden.

| Von außen (`https://gto.growento.com`) | Ziel                               | Session nötig |
| -------------------------------------- | ---------------------------------- | ------------- |
| `/api/*`                               | Backend-Container `127.0.0.1:3010` | je Endpunkt   |
| `/healthz`                             | Backend-Container                  | **nein**      |
| alles andere                           | statische Assets, SPA-Fallback     | nein          |

| Nur lokal (nicht öffentlich) | Port                         |
| ---------------------------- | ---------------------------- |
| Backend-Container            | `BACKEND_HOST_PORT` (3010)   |
| Postgres-Container           | `POSTGRES_HOST_PORT` (55434) |

`/healthz` bleibt bewusst öffentlich und ohne Session — genau dafür wurde die
Ausnahme in T1.3 festgelegt (siehe Abschnitt 2a). Der Host-Nginx und der
Container-Healthcheck rufen ihn ohne Anmeldung auf.

### Proxy-Vertrag (wichtig für das Secure-Cookie)

Der vhost setzt `X-Forwarded-Proto $scheme`. Fehlt dieser Header, kann das
Backend nicht erkennen, dass die Verbindung außen TLS-gesichert ist. Das
`Secure`-Flag des Session-Cookies wird dennoch **nicht** daraus abgeleitet,
sondern explizit über `COOKIE_SECURE` gesetzt (Container-Default `true`) —
so ist das Verhalten unabhängig von der Proxy-Konfiguration eindeutig.

| Header              | Wert                         | Zweck                       |
| ------------------- | ---------------------------- | --------------------------- |
| `Host`              | `$host`                      | Origin-Prüfung, Redirects   |
| `X-Real-IP`         | `$remote_addr`               | Rate-Limit je Client (T1.3) |
| `X-Forwarded-For`   | `$proxy_add_x_forwarded_for` | Nachvollziehbarkeit         |
| `X-Forwarded-Proto` | `$scheme`                    | Schema-Erkennung hinter TLS |

### Einen neuen Service in Compose ergänzen

1. Service in `docker-compose.yml` anlegen.
2. **Keinen Host-Port hart verdrahten.** Immer eine Pflichtvariable verwenden
   und an Loopback binden:
   ```yaml
   ports:
     - '127.0.0.1:${MEIN_SERVICE_PORT:?MEIN_SERVICE_PORT fehlt}:8080'
   ```
3. Variable mit Default und Prüfhinweis in `.env.example` dokumentieren; vorher
   `ss -ltn | grep <port>` prüfen.
4. `healthcheck` ergänzen und abhängige Services über
   `depends_on: { condition: service_healthy }` verknüpfen.
5. Soll der Service von außen erreichbar sein, den Pfad im vhost
   `deploy/nginx/gto.growento.com.conf` ergänzen — **niemals** einen weiteren
   Port direkt ins Internet öffnen.

### Betriebs-Skripte

| Skript                  | Zweck                                                   |
| ----------------------- | ------------------------------------------------------- |
| `deploy/deploy.sh`      | Build → Migration → Neustart → Healthcheck (idempotent) |
| `deploy/backup.sh`      | `pg_dump` + `data/`-Archiv mit Rotation                 |
| `deploy/restore.sh`     | Wiederherstellung, standardmäßig in eine Prüfdatenbank  |
| `deploy/smoke-check.sh` | Erreichbarkeitsprüfung gegen eine laufende Instanz      |

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

| Datei           | Beschreibung                          |
| --------------- | ------------------------------------- |
| `*.md`          | Buch-Volltext als eine Markdown-Datei |
| `pXXXX_YY.jpeg` | Chart-/Abbildungs-Bilder              |

`XXXX` = vierstellige Seitenzahl mit führenden Nullen, `YY` = zweistelliger
Zähler der Abbildung auf dieser Seite, beginnend bei `01`.
Beispiel: `p0042_01.jpeg`.

**Ablage der Bilder (präzisiert in T3.1):** Der Parser erkennt zwei Formen und
nennt die gefundene im Import-Report:

| Form           | Bedingung                                                                   |
| -------------- | --------------------------------------------------------------------------- |
| `flat`         | Die Bilder liegen direkt in `data/book-source/`.                            |
| `subdirectory` | Kein Bild liegt flach, dafür **genau ein** Unterverzeichnis enthält welche. |

Mehr als ein bildhaltiges Unterverzeichnis ist ein Abbruchgrund — dann ist die
Struktur mehrdeutig. Die tatsächlich vorliegende Quelle nutzt `subdirectory`
(ein Verzeichnis `<Buchtitel>_images/`), weil der PDF-nach-Markdown-Export die
Bilder so ablegt und die Bildbezüge im Markdown genau dorthin zeigen.

> **Pflicht:** Das Verzeichnis muss **vor dem Start von AP3** vollständig
> befüllt sein. Andernfalls kann AP3 nicht beginnen — es gibt keinen Fallback
> und keine mitgelieferten Beispieldaten. `resolveBookSource()` bricht mit
> `BookSourceError` ab und nennt Pfad und erwarteten Inhalt.

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

| Schnittstelle                                               | Entsteht in |
| ----------------------------------------------------------- | ----------- |
| CI-Pipeline, E2E-Tests                                      | AP1.T1.6    |
| CLI-Adapter, Host-Runner, Socket-Protokoll                  | AP2.T2.2    |
| API-Adapter (Anthropic Messages API)                        | AP2.T2.3    |
| Prompt-Template-Registry                                    | AP2.T2.4    |
| LLM-Job-Worker, SSE-Statuskanal, `llm_call_log`-Schreibpfad | AP2.T2.5    |
| Settings-Endpunkte für Provider/Modell                      | AP2.T2.6    |

---

## 8. LLM-Gateway — `LLMProvider` als einziger KI-Zugang (AP2.T2.1)

**Regel:** Jeder KI-Aufruf im gesamten Projekt läuft über `LLMProvider` aus
`@gto/shared`. Ein direkter Aufruf der Claude CLI (`child_process`, `spawn`,
`exec`) oder der Anthropic-API (`fetch` gegen `api.anthropic.com`, SDK) **außerhalb
der Adapter in `apps/backend/src/llm/`** ist unzulässig — auch nicht „nur kurz"
in einem Skript oder Test. AP3 (Vision), AP4 (Reports), AP5 (Didaktik),
AP8 (Analyse) und AP9 (Material) docken ausschließlich hier an.

Quelle des Vertrags: `packages/shared/src/llm.ts`. Nach T2.1 existiert **nur**
dieser Vertrag; die Adapter kommen in T2.2/T2.3.

### Der Vertrag

```ts
interface LLMProvider {
  readonly id: LlmProviderId; // 'cli' | 'api'
  complete<TJson = unknown>(request: LlmRequest): Promise<LlmResponse<TJson>>;
}
```

| Export                                              | Art         | Bedeutung                                                               |
| --------------------------------------------------- | ----------- | ----------------------------------------------------------------------- |
| `LLMProvider`                                       | Interface   | der Zugang selbst                                                       |
| `LlmRequest`                                        | Interface   | `system`, `messages`, `model`, `maxTokens`, `jsonSchema?`, `timeoutMs?` |
| `LlmMessage` / `LlmContent`                         | Typen       | Rollen `user`/`assistant`; Inhalt aus Text- **und** Bildbausteinen      |
| `LlmImageContent` / `LLM_IMAGE_MEDIA_TYPES`         | Typ/Const   | Bild als Base64 plus Medientyp (PNG, JPEG, GIF, WebP)                   |
| `LlmResponse`                                       | Interface   | `text`, `json` (nur bei gesetztem `jsonSchema`), `meta`                 |
| `LlmCallMeta`                                       | Interface   | Provider, Modell, Dauer, Tokenzahlen → Spalten von `llm_call_log`       |
| `LLM_ERROR_KINDS` / `LlmErrorKind`                  | Const/Typ   | geschlossene Fehler-Taxonomie                                           |
| `LLM_ERROR_RETRYABLE` / `isLlmErrorRetryable(kind)` | Const/Fn    | Retry-Fähigkeit je Kategorie                                            |
| `LlmErrorPayload`                                   | Interface   | Fehlerform, die beide Adapter liefern                                   |
| `LLM_PROVIDER_IDS` / `isLlmProviderId(v)`           | Const/Guard | erlaubte Provider-Kennungen                                             |

### Bild-Input

`LlmMessage.content` ist immer eine Liste aus Bausteinen; ein Bildbaustein
trägt `mediaType` und Base64-`data` ohne `data:`-Präfix. Das ist keine
Vorratshaltung, sondern Voraussetzung: AP3 wertet über denselben Provider rund
336 Chart-Bilder aus. Der CLI-Adapter setzt das über
`--input-format stream-json` um ([ADR-0021](./DECISIONS.md)).

### Fehler-Taxonomie und Retry

| Kategorie    | Bedeutung                                              | retrybar |
| ------------ | ------------------------------------------------------ | -------- |
| `timeout`    | `timeoutMs` überschritten, Aufruf abgebrochen          | ja       |
| `rate_limit` | Kontingent erschöpft (Subscription-Limit oder API-429) | ja¹      |
| `auth`       | Anmeldung/Konfiguration fehlt oder ungültig            | nein     |
| `transient`  | vorübergehende Störung (Netz, 5xx, Prozessabbruch)     | ja       |
| `invalid`    | Anfrage fehlerhaft (Modell, Schema, Länge)             | nein     |
| `parse`      | Antwort nicht auswertbar                               | nein     |

¹ Retry gehört bei `rate_limit` in die Job-Queue (großes `available_at`), nicht
in den prozessinternen Backoff — ein Subscription-Limit setzt sich erst zur
genannten Uhrzeit zurück. `LlmErrorPayload.retryAfterMs` transportiert den
Zeitpunkt, sofern der Provider ihn nennt.

Die Tabelle ist als `Record<LlmErrorKind, boolean>` typisiert: Eine neue
Kategorie ohne Retry-Aussage übersetzt nicht.

### Die Registry ist der einzige Zugang (seit T2.3)

```ts
import { LlmProviderRegistry, createDbConfigSource } from '../llm/index.js';

const registry = new LlmProviderRegistry({ source: createDbConfigSource(db) });

const provider = await registry.getActive(); // 'cli' oder 'api', je nach Konfiguration
const response = await provider.complete({
  system: 'Du digitalisierst GTO-Charts.',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Los geht es.' }] }],
  model: 'claude-sonnet-5',
  maxTokens: 4096,
});
```

- Einstieg ist **ausschließlich** `apps/backend/src/llm/index.ts`, und dort
  **ausschließlich** die Registry. Die Adapterklassen sind zwar exportiert —
  für die Registry selbst, die Paritätstests und den Ping-Test aus T2.6 —,
  aber ein fachliches Modul instanziiert sie **nicht** direkt.
- Welcher Adapter aktiv ist, entscheidet die Konfiguration:
  `config`-Tabelle (`llm.provider`) → `LLM_PROVIDER` → `cli`. Die Tabelle wird
  bei jedem Aufruf gelesen; eine Umschaltung greift ab dem nächsten Aufruf,
  ohne Neustart und ohne Codeänderung.
- Ein unbekannter Wert ergibt einen `LlmError` der Kategorie `invalid` mit
  Nennung der erlaubten Werte — **kein** stiller Default.
- `createClaudeCliProvider()` wirft `ConfigError`, wenn `CLAUDE_CONFIG_DIR`
  fehlt und dieser Prozess die CLI selbst startet; `createAnthropicApiProvider()`
  wirft `LlmError` der Kategorie `auth`, wenn `ANTHROPIC_API_KEY` fehlt. Es
  gibt **keinen** Rückfall auf ein Default-Profil und keinen stillen Wechsel
  des Providers.
- Fehler kommen immer als `LlmError` (`kind`, `provider`, `message`,
  `retryAfterMs?`, `retryable`). `kind` ist immer eine Kategorie der Taxonomie
  oben — bei **beiden** Adaptern dieselbe, mit derselben Retry-Einstufung.
- Parallelität und Retry liegen in `GuardedProvider` und gelten für jeden
  Adapter. Aufrufer bauen **keinen** eigenen Retry darum.
- Anbindung an Job-Queue, `llm_call_log` und UI gibt es noch nicht — die folgt
  in T2.5/T2.6.

**Nicht erlaubt** ist jeder Weg an diesem Einstieg vorbei: kein
`spawn('claude')` in einem Feature-Modul, kein `fetch` oder SDK-Client gegen
`api.anthropic.com`, kein `new ClaudeCliProvider(...)` in einem Feature-Modul,
kein eigener Prompt-Prozess in einem Skript.

### Konfigurationsquelle der Laufzeitwahl

Seit T2.6 liest die Registry **alle** Aufrufparameter aus der `config`-Tabelle,
nicht nur den Provider:

| Feld            | Schlüssel in `config` | Startwert aus der `.env` |
| --------------- | --------------------- | ------------------------ |
| Provider        | `llm.provider`        | `LLM_PROVIDER`           |
| Modell          | `llm.model`           | `LLM_MODEL`              |
| Timeout         | `llm.timeout_ms`      | `LLM_TIMEOUT_MS`         |
| Nebenläufigkeit | `llm.max_concurrency` | `LLM_MAX_CONCURRENCY`    |
| Versuche        | `llm.max_attempts`    | `LLM_MAX_ATTEMPTS`       |

Rangfolge je Feld: Tabelle → `.env` → fester Default. Gesetzt werden die Werte
über die Einstellungen-Seite (siehe Abschnitt 11); `createSettingsReader(db, config)`
liefert sie an die Registry. `createDbConfigSource(db)` liest weiterhin nur
`llm.provider` und bleibt für Skripte erhalten, die keine vollen Einstellungen
brauchen.

### Der Host-Runner (Container-Betrieb)

Im Container erreicht das Backend die CLI nicht selbst. `LLM_TRANSPORT=socket`
schaltet auf den Host-Runner um:

| Seite  | Wo                                          | Konfiguration                                    |
| ------ | ------------------------------------------- | ------------------------------------------------ |
| Runner | Host, Benutzer `phillip`, `pnpm llm:runner` | `CLAUDE_CONFIG_DIR`, `LLM_RUNNER_SOCKET_DIR`     |
| Client | Backend-Container                           | `LLM_TRANSPORT=socket`, `LLM_RUNNER_SOCKET_PATH` |

Compose hängt **nur** das Socket-Verzeichnis ein, read-only
(`/run/gto-llm:ro`); das Profil-B-Verzeichnis wird nicht gemountet. Protokoll:
eine NDJSON-Zeile je Verbindung, Version in `RUNNER_PROTOCOL_VERSION`. Der
Client bestimmt allein den **Inhalt** der Anfrage — Aufrufform, Werkzeuge,
Arbeitsverzeichnis, Profil und die Timeout-Obergrenze legt der Runner fest.

### Wie ein neuer Adapter andockt

1. `LlmProviderId` in `packages/shared/src/llm.ts` um die Kennung erweitern —
   der Type-Guard und alle `switch`-Zweige über die Taxonomie ziehen nach,
   sonst bricht `tsc`.
2. Klasse in `apps/backend/src/llm/` anlegen, die **`GuardedProvider` erweitert**
   und nur `attempt()` implementiert — einen einzelnen Versuch. Semaphore,
   Retry und die Vorprüfung der Anfrage kommen aus der Basis und werden nicht
   nachgebaut. `meta.provider` ist immer die eigene `id`.
3. Jede Störung auf **genau eine** `LlmErrorKind` abbilden; keine Restklasse,
   keine rohen Provider-Fehler nach außen. Unbekanntes gilt als **nicht**
   wiederholbar.
4. Auswahl geschieht rein über Konfiguration (`config`-Schlüssel
   `llm.provider`), nie über einen Import an der Aufrufstelle. Die Fabrik in
   `registry.ts` bricht die Übersetzung, bis sie den neuen Fall kennt.

**Paritätspflicht.** Ein neuer Adapter ist erst fertig, wenn er die gemeinsame
Suite besteht: `apps/backend/test/llm/parity.test.ts` läuft über eine Tabelle
`ADAPTERS` — ein weiterer Eintrag genügt, die Testfälle bleiben unverändert.
Geprüft werden Erfolgsfall Text, Erfolgsfall mit `jsonSchema` (inklusive
Code-Fence und Wrapper-Text), Bild-Input, jede Fehlerkategorie mit gleicher
Retry-Einstufung, Timeout und das Nebenläufigkeitslimit. Beide Inszenierungen
werden über dieselbe Direktive im Prompt gesteuert (`FAKE:<modus>`), damit
derselbe Request an jeden Adapter gehen kann.

### Konfiguration

`CLAUDE_CONFIG_DIR=/home/phillip/.claude-b` ist **Pflichtvariable** für jeden
Prozess, der die CLI selbst startet (lokales Backend und Host-Runner). Ein
Rückfall auf das Default-Profil `/home/phillip/.claude` ist verboten — fehlt
der Wert, bricht `loadLlmConfig()` mit einer handlungsanweisenden Meldung ab.

Gelesen wird die Konfiguration bei der **Adapter-Initialisierung**, nicht beim
Serverstart: Das Backend muss auch ohne CLI starten können (CI, und ab T2.3 der
reine API-Adapter).

| Variable                          | Bedeutung                                                                           |
| --------------------------------- | ----------------------------------------------------------------------------------- |
| `CLAUDE_CONFIG_DIR`               | Profil B — Pflicht bei `LLM_TRANSPORT=direct`                                       |
| `LLM_TRANSPORT`                   | `direct` (Prozess startet die CLI) oder `socket`                                    |
| `LLM_RUNNER_SOCKET_DIR/_PATH`     | Socket des Host-Runners — Pflicht bei `socket`                                      |
| `LLM_CLI_PATH`, `LLM_CLI_CWD`     | Programm und Arbeitsverzeichnis der CLI                                             |
| `LLM_MODEL`, `LLM_TIMEOUT_MS`     | Vorgaben, wenn der Request nichts angibt                                            |
| `LLM_MAX_CONCURRENCY`             | Obergrenze gleichzeitiger CLI-Prozesse                                              |
| `LLM_MAX_ATTEMPTS`, `LLM_RETRY_*` | Versuche und Backoff (ADR-0023)                                                     |
| `LLM_LIVE_SMOKE`                  | gibt die Live-Tests frei; in der CI nicht gesetzt                                   |
| `LLM_PROVIDER`                    | Startwert des aktiven Providers (`cli`/`api`)                                       |
| `ANTHROPIC_API_KEY`               | Pflicht **nur** bei aktivem Adapter B; wird dem CLI-Prozess **nicht** durchgereicht |
| `ANTHROPIC_BASE_URL`              | abweichende Basis-URL der API (Testserver, Gateway)                                 |

---

## 9. Prompt-Templates — so legt ein Folge-AP ein Template an (AP2.T2.4)

Prompts sind versionierte Dateien, keine Inline-Strings. **Wer ab AP3 einen
KI-Aufruf baut, legt zuerst ein Template an** und rendert es dann über die
`TemplateRegistry` zu einem Provider-Request. Ein Prompt-String im
Anwendungscode ist ein Fehler.

### Schritt 1 — Datei anlegen

Ablage unter `apps/backend/prompts/`, gegliedert nach Art:

| Verzeichnis | Art       | Wofür                                                           |
| ----------- | --------- | --------------------------------------------------------------- |
| `partial/`  | `partial` | wiederverwendbarer Baustein, wird eingebunden                   |
| `persona/`  | `persona` | System-Prompt: Rolle und Verhalten                              |
| `task/`     | `task`    | konkrete Aufgabe; verweist auf eine Persona, wird zur Nachricht |

Die Kennung spiegelt den Pfad ohne Endung: `apps/backend/prompts/task/foo.md`
→ `task/foo`.

### Schritt 2 — Kopfdaten und Rumpf schreiben

```markdown
---
{
  'id': 'task/chapter-quiz',
  'version': 1,
  'kind': 'task',
  'description': 'Erzeugt Verstaendnisfragen zu einem Kapitelabschnitt.',
  'system': 'persona/teacher',
  'placeholders': ['abschnitt'],
  'jsonSchema':
    {
      'type': 'object',
      'properties': { 'fragen': { 'type': 'array', 'items': { 'type': 'string' } } },
      'required': ['fragen'],
      'additionalProperties': false,
    },
}
---

Formuliere Verstaendnisfragen zu diesem Abschnitt.

{{abschnitt}}

{{> partial/json-output}}
```

Regeln, die der Lader beim Start durchsetzt:

| Regel                                                             | Verstoß führt zu                       |
| ----------------------------------------------------------------- | -------------------------------------- |
| `id` eindeutig über alle Dateien                                  | Abbruch mit Nennung **beider** Dateien |
| `version` ganze Zahl ≥ 1, bei inhaltlichen Änderungen erhöhen     | Abbruch                                |
| jeder verwendete `{{name}}` steht in `placeholders`               | Abbruch                                |
| jeder deklarierte Platzhalter wird auch verwendet                 | Abbruch                                |
| `kind: 'task'` verweist über `system` auf eine **Persona**        | Abbruch                                |
| `{{> id}}` zeigt auf ein **Partial**, ohne Zyklus, max. 10 Ebenen | Abbruch                                |

Ein Task muss die Platzhalter seiner Persona **nicht** mitdeklarieren — die
Registry ergänzt sie im Pflichtset. Beim Rendern werden sie trotzdem verlangt.

### Schritt 3 — rendern und aufrufen

```ts
import { TemplateRegistry } from '../prompts/index.js';
import { LlmProviderRegistry } from '../llm/index.js';

const templates = TemplateRegistry.load();

const request = templates.renderRequest(
  'task/chapter-quiz',
  { abschnitt: textAusDerDatenbank, level: 'Fortgeschritten' },
  { model: 'claude-sonnet-5', maxTokens: 2048 },
);

const response = await (await providers.getActive()).complete(request);
```

`renderRequest()` liefert einen **fertigen** `LlmRequest`: System-Prompt aus der
Persona, Aufgabenrumpf als Benutzernachricht, `jsonSchema` aus den Kopfdaten.
Für Partials und Personas einzeln gibt es `renderText(id, werte)`.

**Strikt in beide Richtungen:** Ein fehlender Wert ist ein Fehler, ein Wert
ohne passenden Platzhalter ebenso. Es gibt keinen leeren String und keine
stehengebliebene `{{…}}`-Syntax in der Ausgabe. Eingesetzte Werte werden
**literal** übernommen und nicht erneut als Template gelesen — Buchtext oder
eine Nutzerantwort kann die Prompt-Struktur damit nicht verändern.

### Schritt 4 — Golden-Test ergänzen

Jedes Template braucht mindestens einen Golden-Fall, sonst wird die Suite rot
(Abdeckungstest in `apps/backend/test/prompts/golden.test.ts`).

1. Fall in `TEXT_CASES` (Partial/Persona) oder `REQUEST_CASES` (Task) eintragen,
   mit Beispielwerten.
2. `pnpm prompts:golden` — schreibt die erwarteten Dateien unter
   `apps/backend/test/prompts/golden/`.
3. Die erzeugte Datei **lesen** und mit committen. Sie ist der Beleg dafür, wie
   der Prompt tatsächlich beim Modell ankommt.

Bei jeder späteren Änderung am Template zeigt der Golden-Test den Unterschied
im Diff. Nie blind `pnpm prompts:golden` laufen lassen, um einen roten Test
grün zu bekommen — erst den Diff prüfen. In der CI ist der Update-Modus
gesperrt.

### Was **nicht** in ein Template gehört

- **Keine Fachdaten aus dem Buch** — keine Frequenzen, keine Handbereiche,
  keine Werte aus Tabellen. Die kommen zur Laufzeit als Platzhalterwerte aus
  der Datenbank. Nur so bleibt die Wahrheit deterministisch
  („deterministischer Kern, KI am Rand").
- **Keine Zugangsdaten**, keine Pfade, keine Umgebungswerte.
- **Keine Wiederholung** dessen, was schon in einem Partial steht — binde das
  Partial ein. `partial/language`, `partial/data-truth` und
  `partial/json-output` decken Ansprache, Datenwahrheit und Ausgabeform ab.

### Exportierte Bausteine

| Export                        | Bedeutung                                                |
| ----------------------------- | -------------------------------------------------------- |
| `TemplateRegistry.load(dir?)` | liest alle Templates; ohne Argument aus `PROMPTS_DIR`    |
| `registry.ids()`              | alle Kennungen, sortiert                                 |
| `registry.get(id)`            | geladenes Template samt Kopfdaten und Platzhaltern       |
| `registry.renderText(id, …)`  | gerenderter Text eines Partials oder einer Persona       |
| `registry.renderRequest(…)`   | fertiger `LlmRequest`                                    |
| `TemplateError`               | Fehler beim Laden oder Rendern                           |
| `PROMPTS_DIR`                 | Verzeichnis; im Container über die gleichnamige Variable |

---

## 10. Job-Queue — so registriert ein Folge-AP einen Job-Typ (AP2.T2.5)

Alles, was länger als ein HTTP-Request dauert, läuft als Job. **AP3, AP4, AP8
und AP9 hängen ihre Job-Typen hier ein**; der Worker selbst kennt keine
Fachlichkeit.

### Schritt 1 — Job-Typ schreiben

Ein Job-Typ besteht aus Kennung, Payload-Prüfung und Verarbeitung:

```ts
import { JobPayloadError } from '../jobs/index.js';
import type { JobType } from '../jobs/index.js';

interface ChartPayload {
  readonly chartId: string;
  readonly imageBase64: string;
}

export function createChartDigitizeJob(deps: { … }): JobType<ChartPayload> {
  return {
    type: 'chart.digitize',

    // Wirft bei unbrauchbarer Nutzlast. Das gilt als NICHT wiederholbar:
    // der Job geht sofort in den Dead-Letter, ohne dass ein Aufruf laeuft.
    parsePayload(raw): ChartPayload {
      const value = raw as Partial<ChartPayload>;
      if (typeof value.chartId !== 'string') {
        throw new JobPayloadError('Feld "chartId" fehlt.');
      }
      …
      return { chartId: value.chartId, imageBase64: value.imageBase64 };
    },

    async run(payload, context): Promise<void> {
      // context: { db, job, signal, log }
      const provider = await deps.providers.getActive();
      const request = deps.templates.renderRequest('task/…', { … }, { … });
      const response = await provider.complete(request);
      // Ergebnis selbst wegschreiben - der Worker speichert nichts.
    },
  };
}
```

Registrieren in `apps/backend/src/jobs/runtime.ts`:

```ts
const handlers = new JobHandlerRegistry()
  .register(createLlmCompleteJob({ … }))
  .register(createChartDigitizeJob({ … }));   // ← neu
```

Eine doppelte Kennung ist ein Fehler beim Start, kein stilles Überschreiben.

### Schritt 2 — Jobs einplanen

```ts
import { enqueueJob } from '../jobs/index.js';

await enqueueJob(db, {
  jobType: 'chart.digitize',
  payload: { chartId, imageBase64 },
  maxAttempts: 3, // Default 3
  availableAt: new Date(Date.now() + 60_000), // optional: verzoegern
});
```

Für Betrieb und Diagnose gibt es `pnpm jobs:enqueue` (siehe RUNBOOK 10.2).

### Payload-Vertrag

| Regel                                                              | Konsequenz bei Verstoß                |
| ------------------------------------------------------------------ | ------------------------------------- |
| `payload` ist JSON-serialisierbar (landet in einer `jsonb`-Spalte) | Einplanen scheitert                   |
| `parsePayload` wirft `JobPayloadError` bei Unbrauchbarem           | sofort Dead-Letter, **kein** Aufruf   |
| Unbekannter `jobType`                                              | sofort Dead-Letter                    |
| Große Binärdaten gehören **nicht** in `payload`                    | Tabelle läuft voll; Verweis speichern |

### Retry-Verhalten — der Worker entscheidet, nicht der Handler

| Fehler aus `run()`                                                         | Folge                                                                                |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `LlmError` mit retrybarer Kategorie (`timeout`, `rate_limit`, `transient`) | erneut eingeplant: `attempts + 1`, `available_at` rückt mit Backoff und Streuung vor |
| `LlmError` mit `auth`, `invalid`, `parse`                                  | sofort Dead-Letter                                                                   |
| jeder andere Fehler (Programmfehler, `TemplateError`)                      | sofort Dead-Letter — bei unklarer Ursache wird nicht wiederholt                      |
| `attempts >= max_attempts`                                                 | Dead-Letter mit gespeichertem `last_error`                                           |

Ein Handler baut **keinen** eigenen Retry. Die Semaphore der Adapter (T2.2)
begrenzt weiterhin die Parallelität gegenüber dem Modell — der Worker holt
einen Job je Durchlauf und umgeht sie nicht.

`attempts` steigt **beim Holen**: Ein Absturz zählt mit, sodass ein Job, der
den Worker reproduzierbar umbringt, im Dead-Letter landet statt in einer
Schleife. Ein Job, der länger als `WORKER_STALE_AFTER_MS` (Default 5 min) in
`running` hängt, wird automatisch wieder aufgenommen.

### SSE-Statuskanal

`GET /api/jobs/events` — auth-geschützt, `text/event-stream`.

| Feld                                  | Bedeutung                                         |
| ------------------------------------- | ------------------------------------------------- |
| Ereignisname                          | immer `job`                                       |
| `jobId`, `jobType`                    | Kennung und Typ                                   |
| `status`                              | `running` \| `done` \| `queued` (Retry) \| `dead` |
| `attempts`, `maxAttempts`             | Zählerstand                                       |
| `at`                                  | ISO-8601                                          |
| `errorKind`, `error`, `nextAttemptAt` | nur bei Fehlschlag                                |

Im Frontend führt der Weg über `apiClient.subscribeToJobEvents(fn)`; die
Rückgabe ist die Abmeldung und **muss** beim Verlassen der Seite aufgerufen
werden. Der Server schließt beim Herunterfahren alle Streams; der Ereignisbus
lehnt mehr als 50 gleichzeitige Zuhörer ab, statt unbegrenzt zu wachsen.

`POST /api/jobs/:id/retry` plant einen Dead-Letter-Job erneut ein
(`attempts` zurück auf 0). Ein Job, der nicht `dead` ist, ergibt 409.

### Aufruf-Protokoll

| Endpunkt                                                    | Zweck                               |
| ----------------------------------------------------------- | ----------------------------------- |
| `GET /api/llm/calls?status=success\|error\|pending&limit=n` | Liste ohne Prompt und Antwort       |
| `GET /api/llm/calls/:id`                                    | Einzelner Eintrag mit vollem Inhalt |

Geschrieben wird **nicht** von Aufrufern, sondern zentral vom Dekorator in der
Provider-Registry. Kürzungsregel ([ADR-0028](./DECISIONS.md)):

- **Bilder** stehen nie im Klartext, sondern als
  `[bild image/png, N Zeichen base64 - nicht protokolliert]`.
- **Prompt und Antwort** werden bei `LLM_LOG_MAX_CHARS` (Default 20 000)
  abgeschnitten, mit sichtbarer Markierung
  `… [gekuerzt]: N von M Zeichen entfernt`.
- Ein Fehler beim Protokollieren lässt den Aufruf **nie** scheitern.

---

## 11. Provider- und Modell-Einstellungen (AP2.T2.6)

Der Schreibweg zu den Werten aus Abschnitt 8. Alle drei Routen hängen an
`app.requireSession`; die beiden schreibenden sind CSRF-pflichtig nach dem
Vertrag aus Abschnitt 2a.

| Endpunkt                      | Zweck                                                    |
| ----------------------------- | -------------------------------------------------------- |
| `GET /api/llm/settings`       | geltende Werte, Herkunft je Feld, Modellauswahl, Spannen |
| `PUT /api/llm/settings`       | schreibt nach serverseitiger Prüfung                     |
| `POST /api/llm/settings/ping` | ein minimaler echter Testaufruf                          |

### Lesen

```jsonc
{
  "settings": { "provider": "cli", "model": "claude-sonnet-5",
                "timeoutMs": 120000, "maxConcurrency": 2, "maxAttempts": 3 },
  "origin":   { "provider": "config", "model": "config", "timeoutMs": "config",
                "maxConcurrency": "default", "maxAttempts": "default" },
  "modelChoices": [ { "id": "claude-opus-5", "label": "Opus 5 – …" }, … ],
  "ranges": { "timeoutMs": { "min": 5000, "max": 600000 }, … },
  "apiKeyConfigured": false
}
```

`origin` sagt je Feld, ob der Wert aus der Tabelle oder aus dem Default kommt —
die Oberfläche muss nichts raten. `modelChoices` und `ranges` kommen ebenfalls
vom Server, damit im Frontend nichts hartkodiert ist.

**Der API-Schlüssel wird nie ausgeliefert**, auch nicht maskiert. `apiKeyConfigured`
sagt nur, ob einer hinterlegt ist.

### Schreiben

Alle Felder sind einzeln setzbar; was fehlt, bleibt unverändert. Bei
ungültigen Werten antwortet der Server mit **400** und nennt die Felder
einzeln:

```jsonc
{
  "error": "invalid_settings",
  "message": "Die Einstellungen wurden abgelehnt: timeoutMs.",
  "fields": [
    {
      "field": "timeoutMs",
      "message": "Timeout je Aufruf muss zwischen 5000 und 600000 liegen, ist: 100.",
    },
  ],
}
```

Es wird **nichts** geschrieben und **nie** still auf einen Default
zurückgefallen. Unbekannte Felder werden ebenfalls abgelehnt — eine fachliche
Einstellung aus einem späteren AP gehört nicht hierher.

Im Frontend liefert `ApiError.fields` genau diese Liste; die Oberfläche hängt
die Meldung ans jeweilige Feld.

### Ping-Test

```jsonc
// Erfolg
{ "ok": true, "provider": "cli", "model": "claude-haiku-4-5",
  "durationMs": 4262, "text": "OK", "callId": "5bbc5a01-…" }

// Fehlschlag - HTTP 200, denn der Test selbst hat funktioniert
{ "ok": false, "provider": "api", "kind": "auth",
  "message": "ANTHROPIC_API_KEY fehlt oder ist leer.",
  "hint": "Es ist kein gueltiger ANTHROPIC_API_KEY hinterlegt. Siehe RUNBOOK 9.5.",
  "durationMs": 3 }
```

- Der Aufruf geht über die **Provider-Registry** — Protokoll und Taxonomie
  greifen automatisch, es gibt keinen zweiten Pfad.
- `kind` ist immer eine Kategorie der Taxonomie aus Abschnitt 8, `hint` sagt
  in Klartext, was zu tun ist.
- Optional gegen einen anderen Provider testen: `{ "provider": "api" }`. Das
  ändert die gespeicherte Wahl **nicht**.
- Sperrzeit 10 Sekunden zwischen zwei Pings (429 mit Klartext). Der Aufruf
  kostet echtes Kontingent und läuft nie automatisch.

### Wie ein Folge-AP eine Einstellung hinzufügt

Nur für Werte, die das **Gateway** betreffen. Fachliche Einstellungen
(Lernschwellen, Timer) bekommen ihren eigenen Namensraum in der `config`-Tabelle
und ihre eigenen Routen.

1. Feld in `packages/shared/src/settings.ts` ergänzen (`LlmSettings`, Spanne
   oder Auswahl).
2. Schlüssel in `SETTINGS_KEYS` (`apps/backend/src/llm/settings.ts`) eintragen —
   der `satisfies`-Ausdruck erzwingt Vollständigkeit, ein fehlender Schlüssel
   bricht die Übersetzung.
3. Prüfung in `validate()` ergänzen, Default in `defaultsFrom()`.
4. Feld im Formular ergänzen und einen Frontend-Test dafür schreiben.

---

## 12. Buch-Wissensbasis — Schema und Zugriff (AP3.T3.1)

Quelle der Wahrheit ist `apps/backend/src/db/schema.ts`; Migration
`0002_cold_amphibian.sql`. Die Namens- und Typkonventionen aus Abschnitt 3
gelten unverändert.

### Gemeinsame Bauprinzipien der drei Tabellen

| Spalte           | Zweck                                                                                                                                     |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| fachl. Schlüssel | `chapter_number` / `section_key` / `relative_path`, jeweils mit Unique-Index. Der Re-Import findet Zeilen darüber wieder.                 |
| `content_hash`   | SHA-256 über den fachlichen Inhalt. Gleicher Hash ⇒ die Zeile wird **nicht angefasst**, auch `updated_at` bleibt stehen.                  |
| `removed_at`     | Quellen, die verschwunden sind, werden markiert statt gelöscht. Ein Re-Import wirft damit **keine** nachgelagerten Daten (T3.3/T3.4) weg. |

> **Regel für alle Folge-APs:** `book_asset.id` ist stabil, solange das Asset in
> der Quelle steht. Chart-Daten, Konzeptbezüge und Review-Zustände dürfen daran
> hängen. Wer `book_asset` löscht und neu anlegt, bricht diese Zusage.

### `book_chapter`

| Spalte                       | Typ                | Hinweis                                     |
| ---------------------------- | ------------------ | ------------------------------------------- |
| `id`                         | `uuid` PK          |                                             |
| `part_number` / `part_title` | `integer` / `text` | Teil des Buches (1–3)                       |
| `chapter_number`             | `integer`          | 1–14, eindeutig (`book_chapter_number_key`) |
| `title`                      | `text`             |                                             |
| `ordinal`                    | `integer`          | Reihenfolge im Buch, 0-basiert              |
| `page_start` / `page_end`    | `integer` NULL     | aus den Seitenmarkern `<!-- page N -->`     |
| `content_hash`, `removed_at` | s. o.              |                                             |
| `created_at`, `updated_at`   | `timestamptz`      |                                             |

### `book_section`

| Spalte                       | Typ                        | Hinweis                                                                   |
| ---------------------------- | -------------------------- | ------------------------------------------------------------------------- |
| `id`                         | `uuid` PK                  |                                                                           |
| `chapter_id`                 | `uuid` FK → `book_chapter` | `ON DELETE CASCADE`                                                       |
| `section_key`                | `text`                     | z. B. `ch07/small-blind-pfi-strategy`, eindeutig (`book_section_key_key`) |
| `title`                      | `text`                     |                                                                           |
| `level`                      | `integer`                  | Überschriftsebene der Quelle (2 = `##`, 3 = `###`)                        |
| `ordinal`                    | `integer`                  | Reihenfolge im Kapitel                                                    |
| `body`                       | `text`                     | Volltext des Abschnitts, unverändert                                      |
| `page_start` / `page_end`    | `integer` NULL             | Belegstellen („Seite X") ab AP5                                           |
| `content_hash`, `removed_at` | s. o.                      |                                                                           |

`section_key` enthält **bewusst keine laufende Nummer**: Ein eingeschobener
Abschnitt würde sonst die Schlüssel aller folgenden Sektionen verschieben und
beim nächsten Import alles neu anlegen.

### `book_asset`

| Spalte                       | Typ                        | Hinweis                                                             |
| ---------------------------- | -------------------------- | ------------------------------------------------------------------- |
| `id`                         | `uuid` PK                  | **stabil** über Re-Importe                                          |
| `relative_path`              | `text`                     | Pfad relativ zur Quellwurzel, eindeutig (`book_asset_path_key`)     |
| `file_name`                  | `text`                     | `pXXXX_YY.jpeg`                                                     |
| `section_id`                 | `uuid` FK → `book_section` | `ON DELETE SET NULL`; NULL im Vorspann des Buches                   |
| `page`, `index_on_page`      | `integer` NULL             | aus dem Dateinamen                                                  |
| `caption_raw`                | `text` NULL                | **Rohtext der Unterschrift, verlustfrei** — Gegenprobe in T3.4      |
| `caption_label`              | `text` NULL                | `Hand Range`, `Table`, `Diagram`, `Heatmap`                         |
| `caption_number`             | `integer` NULL             | z. B. 96                                                            |
| `caption_spot`               | `text` NULL                | Spot-Beschreibung, z. B. `SB vs BB (25bb)`                          |
| `caption_actions`            | `jsonb`                    | `[{ "action": "Fold", "percent": 17.9 }]`, Default `[]`             |
| `asset_type`                 | `text`                     | CHECK: `hand_range` \| `table` \| `diagram` \| `formula` \| `other` |
| `classification_confidence`  | `text`                     | CHECK: `certain` \| `uncertain`                                     |
| `classification_rule`        | `text`                     | Name der Regel, die den Typ gesetzt hat                             |
| `file_present`               | `boolean`                  | ist die referenzierte Datei tatsächlich da?                         |
| `ordinal`                    | `integer`                  | Reihenfolge im Buch                                                 |
| `content_hash`, `removed_at` | s. o.                      |                                                                     |

Die zulässigen Werte für `asset_type` und `classification_confidence` stehen als
Vertrag in `packages/shared/src/book.ts` (`BOOK_ASSET_TYPES`,
`BOOK_ASSET_CONFIDENCES`). In `schema.ts` sind sie dupliziert, weil drizzle-kit
das Workspace-Paket beim Bündeln nicht auflöst; `test/book/schema.test.ts` hält
beide Listen deckungsgleich.

### Klassifikationsregeln (Scope-Delta 2)

**Regelbasiert, ohne KI-Aufruf.** Erste passende Regel gewinnt; ihr Name landet
in `classification_rule`. Quelle: `apps/backend/src/book/classify.ts`.

| #   | Regel                   | Bedingung                                               | Typ          | Sicherheit  |
| --- | ----------------------- | ------------------------------------------------------- | ------------ | ----------- |
| 1   | `caption-label`         | Unterschrift trägt ein bekanntes Etikett                | s. Zuordnung | `certain`   |
| 2   | `caption-actions`       | kein Etikett, aber Aktions-Prozente in der Unterschrift | `hand_range` | `uncertain` |
| 3   | `front-matter`          | Asset liegt vor dem ersten Kapitel (Cover, Impressum)   | `other`      | `certain`   |
| 4   | `formula-lead-in`       | keine Unterschrift, Absatz davor endet auf `:`          | `formula`    | `certain`   |
| 5   | `formula-where`         | keine Unterschrift, Absatz danach beginnt mit `where`   | `formula`    | `certain`   |
| 6   | `caption-without-label` | Unterschrift ohne erkennbare Struktur                   | `other`      | `uncertain` |
| 7   | `unclassified`          | nichts davon trifft zu                                  | `other`      | `uncertain` |

Etikett-Zuordnung: `Hand Range` → `hand_range`; `Table` → `table`;
`Diagram`, `Heatmap`, `Figure`, `Chart` → `diagram`.

Unsichere Fälle werden **nicht geraten**: Sie landen als `other`/`uncertain` im
Report und sind dort gezählt. T3.3 behandelt sie bewusst, statt sie stillschweigend
mitlaufen zu lassen.

### Wie T3.3 die Range-Charts abruft

```ts
import { and, eq, isNull } from 'drizzle-orm';
import { bookAsset } from '../db/schema.js';

const charts = await db
  .select({ id: bookAsset.id, path: bookAsset.relativePath, caption: bookAsset.captionRaw })
  .from(bookAsset)
  .where(
    and(
      eq(bookAsset.assetType, 'hand_range'),
      eq(bookAsset.filePresent, true),
      isNull(bookAsset.removedAt),
    ),
  )
  .orderBy(bookAsset.ordinal);
```

- Der Index `book_asset_type_idx (asset_type, ordinal)` bedient genau diese Abfrage.
- **Nur `hand_range`** geht durch die Vision-Pipeline. Jede weitere Kategorie
  kostet Kontingent ohne Nutzen.
- Die Sollwerte für die Gegenprobe in T3.4 stehen in `caption_actions`;
  `caption_raw` bleibt daneben als unveränderter Beleg stehen.

### Wie eine einzelne Sektion geladen wird

Kontextdisziplin: Folge-APs laden **eine** Sektion, nicht ein ganzes Kapitel.

```ts
const [section] = await db
  .select()
  .from(bookSection)
  .where(
    and(eq(bookSection.sectionKey, 'ch07/small-blind-pfi-strategy'), isNull(bookSection.removedAt)),
  );
```

Für ein Inhaltsverzeichnis ohne Volltext reicht eine Projektion ohne `body`
(`select({ key, title, level, ordinal, pageStart })`) — der `body` ist die
größte Spalte des Schemas und wird nur geholt, wenn er gebraucht wird.
Der Index `book_section_chapter_idx (chapter_id, ordinal)` bedient die
Kapitelübersicht.

### Import ausführen

`pnpm book:import` (Import) bzw. `pnpm book:import --dry-run` (nur Analyse,
ohne Datenbank). Betrieb und Reportdeutung: RUNBOOK 11.

---

## 13. Konzept-Graph — Schema, Invarianten und Zugriff (AP3.T3.2)

Quelle der Wahrheit ist `apps/backend/src/db/schema.ts`; Migration
`0003_lively_lilith.sql`. Vertragskonstanten in `packages/shared/src/concept.ts`.

### Die vier Tabellen

**`concept`** — eine fachliche Lerneinheit, nicht eine Gliederungsüberschrift.

| Spalte                     | Typ                        | Hinweis                                                     |
| -------------------------- | -------------------------- | ----------------------------------------------------------- |
| `id`                       | `uuid` PK                  |                                                             |
| `chapter_id`               | `uuid` FK → `book_chapter` | `ON DELETE CASCADE`                                         |
| `slug`                     | `text`                     | normalisierter Titel, eindeutig (`concept_slug_key`)        |
| `title`                    | `text`                     | Fachbegriff wie im Buch                                     |
| `summary`                  | `text`                     | knappe, prüfbare Definition — **ohne Frequenzen**           |
| `topic_area`               | `text`                     | CHECK gegen die feste Liste unten                           |
| `min_level`                | `text`                     | CHECK: `einsteiger` \| `fortgeschritten` \| `experte`       |
| `state`                    | `text`                     | CHECK: `draft` \| `approved`                                |
| `origin`                   | `text`                     | CHECK: `ai` \| `manual`                                     |
| `ordinal`                  | `integer`                  | Reihenfolge im Kapitel                                      |
| `unresolved_prerequisites` | `jsonb`                    | Titel-Referenzen ohne Treffer — offene Punkte, Default `[]` |
| `created_at`, `updated_at` | `timestamptz`              |                                                             |

**`concept_prerequisite`** — gerichtete Kante `prerequisite_id → concept_id`.
Primärschlüssel über beide Spalten; CHECK `concept_id <> prerequisite_id`.

**`concept_section`** — `(concept_id, section_id)`, mehrfach möglich.

**`concept_chart`** — `(concept_id, asset_id)` plus `source` (aktuell
`section`), mehrfach möglich.

### Invarianten

| #   | Invariante                                                    | Durchgesetzt von                                                 |
| --- | ------------------------------------------------------------- | ---------------------------------------------------------------- |
| 1   | Jedes Konzept hat **genau einen** Themenbereich aus der Liste | CHECK `concept_topic_area_check`                                 |
| 2   | `min_level`, `state`, `origin` stammen aus festen Listen      | CHECK je Spalte                                                  |
| 3   | Keine Voraussetzungskante auf sich selbst                     | CHECK `concept_prerequisite_no_self_check`                       |
| 4   | Jede Kante höchstens einmal                                   | Primärschlüssel                                                  |
| 5   | **Der Prerequisite-Graph ist zyklenfrei**                     | `src/concept/graph.ts` — geprüft, nicht erzwingbar (siehe unten) |
| 6   | Ein Titel ergibt genau ein Konzept (Dubletten-Erkennung)      | `concept_slug_key` + `conceptSlug()`                             |

Zu 5: Zyklenfreiheit ist eine Eigenschaft des **ganzen** Graphen und lässt sich
nicht als Constraint schreiben. Stattdessen wird jede neue Kante gegen den
bestehenden Graphen geprüft (`selectAcyclicEdges`, `replacePrerequisites`);
eine Kante, die einen Zyklus schlösse, wird **nicht gespeichert** und erscheint
als Befund. Die Datenbank ist damit jederzeit zyklenfrei — ein Lernpfad ist
immer ableitbar.

### Feste Themenbereiche

Die Achsen des Skill-Ratings in AP4. Quelle: `CONCEPT_TOPIC_AREAS` in
`packages/shared/src/concept.ts`. Begründung: [ADR-0031](./DECISIONS.md).

| Kennung                 | Bezeichnung               | Deckt ab (Kapitel) |
| ----------------------- | ------------------------- | ------------------ |
| `grundlagen-mathematik` | Grundlagen und Mathematik | 1                  |
| `spieltheorie`          | Spieltheorie              | 2                  |
| `software-werkzeuge`    | Software und Werkzeuge    | 3                  |
| `preflop-ranges`        | Preflop-Ranges            | 4, 5, 7            |
| `preflop-verteidigung`  | Preflop-Verteidigung      | 5, 8               |
| `spiel-gegen-3bets`     | Spiel gegen 3-Bets        | 9                  |
| `turnier-metriken-icm`  | Turnier-Metriken und ICM  | 6                  |
| `postflop-grundlagen`   | Postflop-Grundlagen       | 10                 |
| `flop-spiel`            | Flop-Spiel                | 11, 12             |
| `turn-spiel`            | Turn                      | 13                 |
| `river-spiel`           | River                     | 14                 |
| `mental-game`           | Mental Game               | 6                  |

**Regel:** Ein Wert außerhalb dieser Liste wird abgelehnt, nicht auf einen
Default umgebogen — weder beim Import noch über die Review-Ansicht.

### Wie AP4 Konzepte und Themenbereiche liest

Mastery, Wiederholungs-Queue und Skill-Ratings hängen an `concept.id`.
**Nur `approved` Konzepte** sind für AP4 verbindlich; `draft` ist ungeprüfter
Modellvorschlag.

```ts
import { and, asc, eq } from 'drizzle-orm';
import { concept } from '../db/schema.js';

// Alle bestätigten Konzepte eines Themenbereichs - eine Rating-Achse.
const achse = await db
  .select({ id: concept.id, title: concept.title, minLevel: concept.minLevel })
  .from(concept)
  .where(and(eq(concept.topicArea, 'flop-spiel'), eq(concept.state, 'approved')))
  .orderBy(asc(concept.ordinal));
```

Der Index `concept_topic_area_idx` bedient genau diese Abfrage,
`concept_state_idx` die Filterung nach Zustand.

Die Lernreihenfolge ergibt sich aus `concept_prerequisite`: eine topologische
Sortierung über die Kanten `prerequisite_id → concept_id`. Sie terminiert,
weil der Graph zyklenfrei ist (Invariante 5).

### Wie AP5 über `concept_section` gezielt Buchtext lädt

Kontextdisziplin: **ein Konzept, seine Sektionen** — nicht ein ganzes Kapitel.

```ts
const texte = await db
  .select({ key: bookSection.sectionKey, title: bookSection.title, body: bookSection.body })
  .from(conceptSection)
  .innerJoin(bookSection, eq(conceptSection.sectionId, bookSection.id))
  .where(and(eq(conceptSection.conceptId, conceptId), isNull(bookSection.removedAt)))
  .orderBy(asc(bookSection.ordinal));
```

Für die Charts eines Konzepts entsprechend über `concept_chart` auf
`book_asset`. Die Zuordnung ist nach T3.2 **grob** (alles, was in derselben
Sektion steht) und wird in T3.3/T3.4 mit Spot-Metadaten verfeinert.

### Review-Endpunkte (nicht die Content-API)

Prüfoberfläche für die Vorschläge. Die Content-API für Folge-APs entsteht in
T3.5 unter `/api/content`; sie ist hier bewusst nicht vorweggenommen.

| Endpunkt                                  | Zweck                                          |
| ----------------------------------------- | ---------------------------------------------- |
| `GET /api/concepts`                       | alle Konzepte nach Kapitel, samt Befunden      |
| `PATCH /api/concepts/:id`                 | Titel, Definition, Einordnung, Voraussetzungen |
| `POST /api/concepts/:id/approve`          | ein Konzept bestätigen                         |
| `POST /api/concepts/chapters/:nr/approve` | Sammelaktion je Kapitel                        |

Alle auth-geschützt; die schreibenden zusätzlich über den CSRF-Hook aus T1.3.
Ablehnungen kommen feldweise als `{ error: 'invalid_concept', fields: [...] }` —
dasselbe Muster wie die Einstellungen aus T2.6, und im Frontend über dieselbe
Auswertung in `ApiError.fields`.

Befundarten in `GET /api/concepts` (`ConceptIssueKind`):
`unresolved-prerequisite`, `cycle`, `duplicate`, `without-section`,
`chapter-empty`.

### Generierung anstoßen

`pnpm concepts:generate [--plan] [--chapter <n>] [--charts] [--report]`.
Ein Job je Kapitelteil (Zeichenbudget 15 000) über die Queue; Betrieb siehe
RUNBOOK 12.
