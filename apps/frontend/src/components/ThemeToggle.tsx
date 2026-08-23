import { useTheme } from '../theme/ThemeProvider.js';

/** Schaltet zwischen hellem und dunklem Modus um. */
export function ThemeToggle(): JSX.Element {
  const { theme, toggleTheme } = useTheme();
  const toDark = theme === 'light';

  return (
    <button
      type="button"
      className="button button--secondary"
      onClick={toggleTheme}
      aria-pressed={theme === 'dark'}
      title={toDark ? 'Zum dunklen Modus wechseln' : 'Zum hellen Modus wechseln'}
    >
      {toDark ? '🌙 Dunkel' : '☀️ Hell'}
    </button>
  );
}
