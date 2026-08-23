/**
 * Platzhalterseite fuer die fuenf Bereiche der Seitenleiste.
 *
 * Bewusst ohne Fachlogik: Inhalte kommen laut Kanon erst in AP5-AP9. Die Seite
 * benennt nur, was hier spaeter entsteht und welches Arbeitspaket zustaendig
 * ist.
 */
export interface PlaceholderPageProps {
  readonly title: string;
  /** Zustaendiges Arbeitspaket, z. B. "AP5". */
  readonly plannedIn: string;
  readonly description: string;
}

export function PlaceholderPage({
  title,
  plannedIn,
  description,
}: PlaceholderPageProps): JSX.Element {
  return (
    <section>
      <h1>{title}</h1>
      <p>
        <span className="badge">geplant für {plannedIn}</span>
      </p>
      <div className="card">
        <p className="muted">{description}</p>
        <p className="muted">
          Diese Seite ist absichtlich leer — sie belegt nur die Route, damit die Navigation
          vollständig bedienbar ist.
        </p>
      </div>
    </section>
  );
}
