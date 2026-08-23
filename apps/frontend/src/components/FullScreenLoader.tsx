/** Ladezustand, der eine ganze Seite einnimmt. */
export function FullScreenLoader({ label }: { label: string }): JSX.Element {
  return (
    <div className="center-screen">
      <p className="muted" role="status" aria-live="polite">
        {label}
      </p>
    </div>
  );
}
