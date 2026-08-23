import { Link } from 'react-router-dom';

/** Auffangseite fuer unbekannte Pfade. */
export function NotFoundPage(): JSX.Element {
  return (
    <section>
      <h1>Seite nicht gefunden</h1>
      <p className="muted">Diesen Pfad gibt es nicht.</p>
      <Link to="/">Zurück zum Dashboard</Link>
    </section>
  );
}
