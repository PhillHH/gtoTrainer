import { useAuth } from '../auth/AuthContext.js';
import './DashboardPage.css';

/**
 * Startseite nach dem Login.
 *
 * Fachlich leer, aber vollstaendig bedienbar: Begruessung, angemeldeter
 * Benutzer und benannte Platzhalter fuer die spaeteren Inhalte.
 */
const PLACEHOLDER_CARDS: ReadonlyArray<{ title: string; plannedIn: string; text: string }> = [
  {
    title: 'Fortschritt',
    plannedIn: 'AP4',
    text: 'Lernstand je Thema und Gesamtfortschritt.',
  },
  {
    title: 'Fällige Wiederholungen',
    plannedIn: 'AP4',
    text: 'Was heute nach dem Wiederholungsplan ansteht.',
  },
  {
    title: 'Fehler-Muster',
    plannedIn: 'AP6',
    text: 'Wiederkehrende Fehler aus Drills und Auswertungen.',
  },
];

export function DashboardPage(): JSX.Element {
  const { user } = useAuth();

  return (
    <section>
      <h1>Willkommen zurück{user ? `, ${user.username}` : ''}</h1>
      <p className="muted">
        Das Grundgerüst steht. Die fachlichen Inhalte kommen mit den folgenden Arbeitspaketen.
      </p>

      <div className="dashboard__grid">
        {PLACEHOLDER_CARDS.map((card) => (
          <article key={card.title} className="card">
            <h2 className="dashboard__card-title">{card.title}</h2>
            <p>
              <span className="badge">kommt in {card.plannedIn}</span>
            </p>
            <p className="muted">{card.text}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
