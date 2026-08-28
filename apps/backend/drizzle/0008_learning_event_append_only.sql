-- AP4.T4.1 - `learning_event` ist append-only.
--
-- Handgeschriebene Migration: drizzle-kit erzeugt keine Trigger. Sie ist ueber
-- `drizzle-kit generate --custom` angelegt und damit regulaer im Journal
-- eingetragen.
--
-- Warum ein Trigger und nicht nur eine Zusage in der Doku: Der Replay in T4.2
-- rekonstruiert den abgeleiteten Zustand allein aus diesem Protokoll. Ein
-- nachtraeglich geaendertes oder geloeschtes Ereignis erzeugte still einen
-- anderen Zustand - der Vergleich "Replay == inkrementell" waere wertlos. Die
-- Unveraenderlichkeit muss deshalb an der Datenbank haengen, nicht am
-- Wohlverhalten des aufrufenden Codes.
--
-- Eine Korrektur ist kein UPDATE, sondern ein **neues** Ereignis vom Typ
-- `manual_correction` mit `corrects_event_id` auf das urspruengliche Ereignis.
--
-- Bewusst NICHT abgedeckt: TRUNCATE. Es umgeht Zeilentrigger, braucht aber ein
-- eigenes Tabellenrecht und ist keine schleichende Aenderung, sondern eine
-- ausdrueckliche Verwerfung des ganzen Protokolls. Genau darauf setzt der
-- dokumentierte Neuanfang auf (`resetLearningState`, RUNBOOK 16.3). Ein
-- Statement-Trigger darauf wuerde ausserdem jedes `TRUNCATE ... CASCADE` auf
-- `concept` oder `book_chapter` mitreissen - siehe ADR-0039.

CREATE OR REPLACE FUNCTION learning_event_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'learning_event ist append-only: % ist nicht zulaessig. Eine Korrektur wird als neues Ereignis vom Typ manual_correction mit corrects_event_id angelegt.',
    TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER learning_event_no_update
  BEFORE UPDATE ON learning_event
  FOR EACH ROW EXECUTE FUNCTION learning_event_append_only();
--> statement-breakpoint
CREATE TRIGGER learning_event_no_delete
  BEFORE DELETE ON learning_event
  FOR EACH ROW EXECUTE FUNCTION learning_event_append_only();
