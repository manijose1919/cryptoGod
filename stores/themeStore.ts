import { create } from 'zustand';

interface ThemeState {
  isDark: boolean;
  toggle: () => void;
}

export const useThemeStore = create<ThemeState>((set) => {
  // Initialize from localStorage, default to light
  const stored = typeof window !== 'undefined' ? localStorage.getItem('theme') : null;
  const isDark = stored ? stored === 'dark' : false;

  // Apply on load
  if (typeof document !== 'undefined') {
    document.documentElement.classList.toggle('dark', isDark);
    document.documentElement.classList.toggle('light', !isDark);
  }

  return {
    isDark,
    toggle: () =>
      set((state) => {
        const next = !state.isDark;
        localStorage.setItem('theme', next ? 'dark' : 'light');
        document.documentElement.classList.toggle('dark', next);
        document.documentElement.classList.toggle('light', !next);
        return { isDark: next };
      }),
  };
});
