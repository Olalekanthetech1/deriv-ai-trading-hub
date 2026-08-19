'use client';

import { Moon, Sun } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { ReactNode, useEffect, useState } from 'react';

const STORAGE_KEY = 'admin-theme';
type AdminTheme = 'light' | 'dark';

export function AdminThemeProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [theme, setTheme] = useState<AdminTheme>('dark');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    const next: AdminTheme = saved === 'light' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.classList.toggle('admin-theme-light', next === 'light');
    setReady(true);
  }, [pathname]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY) return;
      const next: AdminTheme = event.newValue === 'light' ? 'light' : 'dark';
      setTheme(next);
      document.documentElement.classList.toggle('admin-theme-light', next === 'light');
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const toggleTheme = () => {
    setTheme((current) => {
      const next: AdminTheme = current === 'light' ? 'dark' : 'light';
      window.localStorage.setItem(STORAGE_KEY, next);
      document.documentElement.classList.toggle('admin-theme-light', next === 'light');
      return next;
    });
  };

  const showGlobalToggle = pathname !== '/admin';

  return (
    <div className="admin-theme-surface min-h-screen">
      {children}
      {ready && showGlobalToggle && (
        <button
          type="button"
          onClick={toggleTheme}
          aria-label={theme === 'light' ? 'Switch admin pages to dark theme' : 'Switch admin pages to light theme'}
          title={theme === 'light' ? 'Dark theme' : 'Light theme'}
          className="fixed bottom-5 right-5 z-[100] inline-flex items-center gap-2 rounded-xl border border-slate-300/60 bg-white/95 px-3 py-2 text-xs font-semibold text-slate-800 shadow-lg shadow-slate-900/10 backdrop-blur transition hover:scale-[1.02] dark:border-white/10 dark:bg-slate-950/90 dark:text-slate-100"
        >
          {theme === 'light' ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
          {theme === 'light' ? 'Dark' : 'Light'}
        </button>
      )}
    </div>
  );
}
