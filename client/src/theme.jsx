import { useEffect, useState } from 'react';

const KEY = 'workbench-theme';

function currentTheme() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

export function ThemeToggle({ className = 'link small' }) {
  const [theme, setTheme] = useState(currentTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem(KEY, theme); } catch { /* storage unavailable */ }
  }, [theme]);

  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button type="button" className={className} onClick={() => setTheme(next)} title={`Switch to ${next} theme`}>
      {theme === 'dark' ? '☀ Light theme' : '☾ Dark theme'}
    </button>
  );
}
