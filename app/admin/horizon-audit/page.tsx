'use client';

import Link from 'next/link';
import { ArrowLeft, Sparkles } from 'lucide-react';
import { HorizonExecutionAuditPanel } from '@/components/admin/horizon-execution-audit-panel';

export default function HorizonAuditPage() {
  return (
    <div className="min-h-screen bg-[#05070b] text-white p-4 md:p-8 space-y-6">
      <header className="max-w-7xl mx-auto flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 rounded-3xl border border-white/10 bg-white/[0.03] p-5 backdrop-blur-xl">
        <div className="flex items-center gap-3">
          <div className="rounded-2xl border border-emerald-400/20 bg-emerald-400/10 p-3">
            <Sparkles className="h-6 w-6 text-emerald-300" />
          </div>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-emerald-300">
              Operations Center · Real-Time Telemetry
            </p>
            <h1 className="text-2xl font-black tracking-tight sm:text-3xl">Horizon Execution Audit</h1>
          </div>
        </div>
        <Link
          href="/admin"
          className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-xs font-semibold text-slate-300 hover:bg-white/10 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" /> Operations Center
        </Link>
      </header>
      <main className="max-w-7xl mx-auto">
        <HorizonExecutionAuditPanel />
      </main>
    </div>
  );
}
