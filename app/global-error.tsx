'use client';

import { useEffect } from 'react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[GlobalError caught]:', error);
  }, [error]);

  return (
    <html lang="en" className="dark h-full">
      <body className="h-full bg-slate-950 text-slate-100 flex items-center justify-center p-4 font-sans antialiased">
        <div className="max-w-md w-full bg-slate-900 border border-slate-800 rounded-xl p-6 shadow-2xl text-center space-y-4">
          <div className="mx-auto w-12 h-12 rounded-full bg-red-500/10 border border-red-500/20 flex items-center justify-center text-red-400">
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <div>
            <h2 className="text-xl font-semibold text-slate-100">Application Error</h2>
            <p className="text-sm text-slate-400 mt-1">
              {error?.message || 'An unexpected error occurred in the application context.'}
            </p>
            {error?.digest && (
              <p className="text-xs font-mono text-slate-500 mt-2 bg-slate-950/50 p-2 rounded border border-slate-800 break-all">
                Digest: {error.digest}
              </p>
            )}
          </div>
          <div className="flex items-center justify-center gap-3 pt-2">
            <button
              onClick={() => reset()}
              className="px-4 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition-colors shadow-lg shadow-emerald-600/20"
            >
              Try Again
            </button>
            <button
              onClick={() => typeof window !== 'undefined' && window.location.reload()}
              className="px-4 py-2 text-sm font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg transition-colors"
            >
              Reload Page
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}

