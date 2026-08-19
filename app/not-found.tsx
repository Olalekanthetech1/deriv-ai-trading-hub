'use client';

import React from 'react';
import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center p-4 bg-background text-foreground">
      <div className="max-w-md w-full rounded-2xl border border-border bg-card p-6 text-center space-y-4 shadow-xl">
        <h2 className="text-xl font-bold text-foreground">404 - Page Not Found</h2>
        <p className="text-xs text-muted-foreground">
          The requested page could not be found.
        </p>
        <Link
          href="/"
          className="inline-block rounded-lg bg-cyan-600 px-4 py-2 text-xs font-semibold text-white hover:bg-cyan-500 transition shadow-md"
        >
          Return to Trading
        </Link>
      </div>
    </div>
  );
}
