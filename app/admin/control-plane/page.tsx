import Link from 'next/link';

const groups = [
  {
    title: 'Observe & Respond',
    description: 'Investigate runtime health, telemetry and active incidents.',
    routes: [
      ['command-center', 'Command Center', 'Live operational readiness and service health.'],
      ['operational-intelligence', 'Operational Intelligence', 'Correlate health, telemetry, ML state and production risk.'],
      ['observability', 'Observability', 'Persisted telemetry, correlation IDs and event stream.'],
      ['incident-center', 'Incident Center', 'Operational incidents, severity and response workflow.'],
      ['signal-forensics', 'Signal Forensics', 'Trace signal decisions and supporting evidence.'],
    ],
  },
  {
    title: 'ML & Model Operations',
    description: 'Manage the model lifecycle without mixing training and production inference.',
    routes: [
      ['models', 'Model Operations', 'Registry, model metadata and production state.'],
      ['ml-config', 'ML Pipeline Configuration', 'Controlled configuration for the ML pipeline.'],
      ['training-pipeline', 'Training Pipeline', 'Training jobs, datasets and execution state.'],
      ['retraining', 'Retraining & Automation', 'Scheduled and manual retraining controls.'],
      ['champion-challenger', 'Champion / Challenger', 'Compare candidates before production promotion.'],
      ['prediction-integration', 'Prediction Integration', 'Production prediction-path verification.'],
    ],
  },
  {
    title: 'Market & Strategy',
    description: 'Inspect the data and strategy layers feeding signal generation.',
    routes: [
      ['market-data-ingestion', 'Market Data Ingestion', 'Provider connectivity, freshness and ingestion state.'],
      ['asset-strategy', 'Asset-Aware Strategy', 'Asset-specific strategy and regime controls.'],
      ['dataset-builder', 'Training Dataset Builder', 'Build and inspect model training datasets.'],
      ['experiments', 'Testing & Research', 'Experiments, evaluations and research evidence.'],
    ],
  },
  {
    title: 'Production & Governance',
    description: 'Verify production state and protect operational infrastructure.',
    routes: [
      ['final-verification', 'Production Verification', 'Evidence-based production readiness checks.'],
      ['security', 'Security', 'Security posture and administrative controls.'],
      ['database', 'Database Operations', 'Database diagnostics and operational maintenance.'],
    ],
  },
];

export default function ControlPlanePage() {
  return (
    <main className="min-h-screen bg-[#05070b] px-4 py-8 text-slate-100">
      <div className="mx-auto max-w-7xl">
        <Link href="/admin" className="text-xs text-cyan-300">← Operations Center</Link>
        <header className="mt-5 rounded-3xl border border-white/10 bg-white/[0.03] p-6">
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan-300">Operations Control Plane</p>
          <h1 className="mt-2 text-3xl font-black tracking-tight">Production Administration Directory</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-500">
            One indexed entry point for operational investigation, ML lifecycle management, market-data diagnostics and production verification. Navigation does not infer service health; each destination remains responsible for source-backed evidence.
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            <Link href="/admin/command-center" className="rounded-xl border border-cyan-400/20 bg-cyan-400/10 px-3 py-2 text-xs font-semibold text-cyan-200 hover:bg-cyan-400/15">Open Command Center →</Link>
            <Link href="/admin/operational-intelligence" className="rounded-xl border border-cyan-400/20 bg-cyan-400/10 px-3 py-2 text-xs font-semibold text-cyan-200 hover:bg-cyan-400/15">Operational Intelligence →</Link>
            <Link href="/admin/observability" className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-slate-300 hover:bg-white/10">Open Observability →</Link>
            <Link href="/admin/incident-center" className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-slate-300 hover:bg-white/10">Open Incident Center →</Link>
            <Link href="/admin/final-verification" className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-slate-300 hover:bg-white/10">Production Verification →</Link>
          </div>
        </header>

        <div className="mt-8 space-y-8">
          {groups.map((group) => (
            <section key={group.title}>
              <div className="mb-3">
                <h2 className="text-base font-bold">{group.title}</h2>
                <p className="mt-1 text-xs text-slate-600">{group.description}</p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {group.routes.map(([id, title, description]) => (
                  <Link key={id} href={`/admin/${id}`} className="group rounded-2xl border border-white/10 bg-white/[0.025] p-4 transition hover:border-cyan-400/25 hover:bg-white/[0.04]">
                    <div className="flex items-start justify-between gap-3">
                      <p className="font-bold text-slate-100">{title}</p>
                      <span className="text-xs text-slate-700 transition group-hover:text-cyan-300">→</span>
                    </div>
                    <p className="mt-2 text-xs leading-5 text-slate-500">{description}</p>
                  </Link>
                ))}
              </div>
            </section>
          ))}
        </div>

        <footer className="mt-8 rounded-2xl border border-cyan-400/10 bg-cyan-400/[0.025] p-4 text-xs leading-5 text-slate-500">
          <span className="font-semibold text-cyan-300">Control-plane integrity rule:</span> this directory is navigation only. Health, readiness, incident state and production claims must come from the destination's authoritative server-side sources.
        </footer>
      </div>
    </main>
  );
}
