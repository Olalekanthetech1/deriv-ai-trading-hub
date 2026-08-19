'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

type DatabaseData = {
  status: string;
  configured: boolean;
  latencyMs?: number;
  databaseName?: string | null;
  schemaName?: string | null;
  serverTime?: string | null;
  version?: string | null;
  tables?: string[];
  tableCount?: number;
  error?: string;
  schema?: {
    version?: number | null;
    expectedTableCount: number;
    expectedTablesPresent: number;
    missingExpectedTables: string[];
  };
  integrity?: Record<string, boolean>;
};

export default function DatabaseOperationsPage() {
  const [data, setData] = useState<DatabaseData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true); setError(null);
    try {
      const response = await fetch('/api/admin/database', { cache: 'no-store' });
      const json = await response.json();
      setData(json);
      if (!response.ok && json?.error) setError(json.error);
    } catch (err: any) { setError(err?.message || 'Database diagnostics unavailable.'); }
    finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, []);

  return <main className="min-h-screen bg-[#05070b] px-4 py-6 text-slate-100 sm:px-6 lg:px-8"><div className="mx-auto max-w-6xl">
    <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><Link href="/admin" className="text-xs text-cyan-300 hover:text-cyan-200">← Admin Operations</Link><h1 className="mt-2 text-2xl font-black">Database Operations</h1><p className="mt-1 text-sm text-slate-500">Live Neon PostgreSQL connectivity, schema verification and data integrity diagnostics.</p></div><button onClick={load} className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-xs font-semibold hover:bg-white/10">Refresh</button></header>
    {loading && <div className="rounded-2xl border border-white/10 bg-white/[0.025] p-8 text-center text-sm text-slate-400">Initializing and verifying the live database schema…</div>}
    {data && <div className="space-y-5">
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><div className={`rounded-2xl border p-4 ${data.status === 'HEALTHY' ? 'border-emerald-400/20 bg-emerald-400/5' : 'border-amber-400/20 bg-amber-400/5'}`}><span className="text-xs text-slate-500">Runtime status</span><p className="mt-2 text-xl font-black">{data.status}</p></div><div className="rounded-2xl border border-white/10 bg-white/[0.025] p-4"><span className="text-xs text-slate-500">Query latency</span><p className="mt-2 text-xl font-black">{data.latencyMs != null ? `${data.latencyMs} ms` : 'UNAVAILABLE'}</p></div><div className="rounded-2xl border border-white/10 bg-white/[0.025] p-4"><span className="text-xs text-slate-500">Schema version</span><p className="mt-2 text-xl font-black">{data.schema?.version ?? 'UNAVAILABLE'}</p></div><div className="rounded-2xl border border-white/10 bg-white/[0.025] p-4"><span className="text-xs text-slate-500">New tables</span><p className="mt-2 text-xl font-black">{data.schema ? `${data.schema.expectedTablesPresent}/${data.schema.expectedTableCount}` : 'UNAVAILABLE'}</p></div></section>
      {error && <div className="rounded-2xl border border-red-400/20 bg-red-400/5 p-5 text-sm text-red-200">{error}</div>}
      {data.schema && <section className="rounded-2xl border border-emerald-400/15 bg-emerald-400/[0.03] p-5"><h2 className="text-sm font-bold text-emerald-200">Schema integrity</h2><p className="mt-2 text-xs leading-6 text-slate-400">{data.schema.missingExpectedTables.length === 0 ? 'All expected Operations Center tables are present.' : `${data.schema.missingExpectedTables.length} expected table(s) are missing.`}</p>{data.schema.missingExpectedTables.length > 0 && <p className="mt-3 font-mono text-[11px] text-amber-300">{data.schema.missingExpectedTables.join(', ')}</p>}</section>}
      <section className="rounded-2xl border border-white/10 bg-white/[0.025] p-5"><h2 className="mb-4 text-sm font-bold">Live schema</h2>{data.tables?.length ? <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{data.tables.map((table) => <div key={table} className="rounded-xl border border-white/10 bg-black/20 px-4 py-3 font-mono text-xs text-slate-300">{table}</div>)}</div> : <p className="text-sm text-slate-500">No live tables were returned.</p>}</section>
      <section className="rounded-2xl border border-cyan-400/15 bg-cyan-400/[0.03] p-5 text-xs leading-6 text-slate-400"><strong className="text-cyan-200">Integrity rule:</strong> DATABASE_URL being present is only configuration. The console initializes the active schema and marks the database healthy only after real SQL queries succeed. All displayed schema and health values are derived from the live database.</section>
    </div>}
  </div></main>;
}
