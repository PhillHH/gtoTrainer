-- AP4.T4.5 - `level_set`: das erste Ereignis ohne Konzeptbezug (ADR-0044).
--
-- Der Nutzer darf sein Level selbst setzen, wenn die Automatik danebenliegt.
-- Das geschieht als **Ereignis**, nicht als direkter Schreibzugriff - sonst
-- waere es der zweite Schreibweg, den das Umgehungsverbot aus T4.2 ausschliesst,
-- und der Replay wuesste nichts davon.
--
-- Ein Level bezieht sich aber auf keinen Konzeptbezug. `concept_id` wird
-- deshalb nullable. Damit die Invariante aus T4.1 fuer alle anderen
-- Ereignistypen unveraendert gilt, tritt ein CHECK an ihre Stelle: Ein
-- Ereignis ist **entweder** ein Lernereignis an einem Konzept **oder** ein
-- globales Ereignis am Lernenden. Ein Lernereignis ohne Konzept bleibt damit
-- unmoeglich - es wuerde von keiner Ableitung erfasst und stuende wirkungslos
-- im Protokoll.

ALTER TABLE "learning_event" DROP CONSTRAINT "learning_event_type_check";--> statement-breakpoint
ALTER TABLE "learning_event" ALTER COLUMN "concept_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "learning_event" ADD CONSTRAINT "learning_event_scope_check" CHECK ((event_type = 'level_set') = (concept_id is null));--> statement-breakpoint
ALTER TABLE "learning_event" ADD CONSTRAINT "learning_event_type_check" CHECK (event_type in ('question_answered', 'concept_explained', 'drill_completed', 'hand_analyzed', 'review_performed', 'manual_correction', 'level_set'));