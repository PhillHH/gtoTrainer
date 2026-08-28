-- AP4.T4.3 - Mastery-Schwelle: Default 0.8 -> 0.75 (ADR-0042).
--
-- Grund: T4.1 setzte 0.8, als der Score noch ein arithmetisches Mittel war.
-- Seit T4.3 rechnet er mit Vorwissens-Prior, Zeitgewichtung und
-- Fehler-Asymmetrie; 0.8 erreicht damit erst, wer vier saubere objektive
-- Treffer hinlegt. Zusammen mit der ohnehin geforderten Mindestzahl objektiver
-- Anker waere das doppelt gemoppelt - die Absicherung gegen R3 sitzt in den
-- Ankern, nicht in einer moeglichst hohen Zahl.
ALTER TABLE "learner_state" ALTER COLUMN "mastery_threshold" SET DEFAULT 0.75;
--> statement-breakpoint
-- Bestehende Zeilen, die noch exakt auf dem alten Seed-Default stehen,
-- ziehen mit. Das ueberschreibt keine Nutzerentscheidung: Bis T4.3 gab es
-- keinen Weg, den Wert zu aendern - weder Endpunkt noch Kommando -, ein
-- vorgefundenes 0.8 ist also zwangslaeufig der Seed-Wert aus T4.1. Ein
-- abweichender Wert bleibt unangetastet.
UPDATE "learner_state" SET "mastery_threshold" = 0.75 WHERE "mastery_threshold" = 0.8;
