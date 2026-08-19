'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Beaker, CheckCircle2, Clock3, Database, FlaskConical, History, Loader2, Play, Radio, RefreshCw, ShieldCheck, Target, TestTube2, XCircle } from 'lucide-react';

type SymbolItem = { symbol?: string; displayName?: string; name?: string };
type Experiment = { experiment_id: string; experiment_type: string; symbol: string; horizon_seconds?: number | null; status: string; parameters?: Record<string, unknown>; result?: Record<string, unknown>; created_at: string };
type DataSource = 'live-database' | 'unavailable' | 'not-loaded';

const asNumber = (value: unknown) => { const n = Number(value); return Number.isFinite(n) ? n : null; };

function Metric({ label, value, suffix = '' }: { label: string; value: unknown; suffix?: string }) {
  const number = asNumber(value);
  const display = number === null ? '—' : `${number.toLocaleString()}${suffix}`;
  return <div className="rounded-xl border border-white/10 bg-black/20 p-4"><p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">{label}</p><p className="mt-1 text-xl font-black text-slate-100">{display}</p></div>;
}

export default function TestingResearchPage() {
  const [symbols, setSymbols] = useState<SymbolItem[]>([]);
  const [symbol, setSymbol] = useState('');
  const [horizons, setHorizons] = useState<number[]>([]);
  const [backtestHorizon, setBacktestHorizon] = useState<number | null>(null);
  const [confidence, setConfidence] = useState<number | null>(null);
  const [stake, setStake] = useState<number | null>(null);
  const [payoutRate, setPayoutRate] = useState<number | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [tab, setTab] = useState<'backtest' | 'multi-horizon' | 'paper-shadow' | 'history'>('backtest');
  const [loading, setLoading] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [dataSource, setDataSource] = useState<DataSource>('not-loaded');
  const [result, setResult] = useState<Record<string, any> | null>(null);
  const [lastExperimentId, setLastExperimentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedSymbolName = useMemo(() => {
    const item = symbols.find((entry) => entry.symbol === symbol);
    return item?.displayName || item?.name || symbol || 'No live market selected';
  }, [symbols, symbol]);

  const loadSymbols = async () => {
    try {
      const response = await fetch('/api/symbols', { cache: 'no-store' });
      const data = await response.json().catch(() => null);
      if (!response.ok || !Array.isArray(data?.symbols) || data.symbols.length === 0) throw new Error(data?.error || 'Live Deriv symbols are unavailable.');
      setSymbols(data.symbols);
      setSymbol((current) => current && data.symbols.some((entry: SymbolItem) => entry.symbol === current) ? current : String(data.symbols[0]?.symbol || ''));
    } catch (err: any) {
      setSymbols([]);
      setSymbol('');
      setError(err?.message || 'Unable to load live Deriv symbols.');
    }
  };

  const loadRegistryHorizons = async () => {
    try {
      const response = await fetch('/api/ml/registry', { cache: 'no-store' });
      const data = await response.json().catch(() => null);
      if (!response.ok || !Array.isArray(data?.models)) { setHorizons([]); setBacktestHorizon(null); return; }
      const values: number[] = Array.from(new Set<number>(data.models.map((model: any) => Number(model?.horizon_secs)).filter((value: number) => Number.isFinite(value) && value > 0))).sort((a: number, b: number) => a - b);
      setHorizons(values);
      setBacktestHorizon((current) => current !== null && values.includes(current) ? current : values[0] ?? null);
    } catch { setHorizons([]); setBacktestHorizon(null); }
  };

  const loadHistory = async () => {
    setHistoryLoading(true);
    try {
      const response = await fetch('/api/admin/experiments', { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || 'Unable to load experiment history.');
      setExperiments(Array.isArray(data?.experiments) ? data.experiments : []);
      setDataSource(data?.dataSource === 'live-database' ? 'live-database' : 'unavailable');
    } catch (err: any) {
      setDataSource('unavailable');
      setError(err?.message || 'Unable to load experiment history.');
    } finally { setHistoryLoading(false); }
  };

  useEffect(() => { void loadSymbols(); void loadRegistryHorizons(); void loadHistory(); }, []);

  const persistExperiment = async (experimentType: string, parameters: Record<string, unknown>, experimentResult: Record<string, unknown>, horizonSeconds?: number) => {
    if (!symbol) throw new Error('A live market symbol is required.');
    const response = await fetch('/api/admin/experiments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ experimentType, symbol, horizonSeconds, parameters, result: experimentResult }) });
    const data = await response.json();
    if (!response.ok || !data?.success) throw new Error(data?.error || 'Experiment completed but could not be persisted.');
    setLastExperimentId(data.experimentId);
    await loadHistory();
  };

  const runBacktest = async () => {
    if (!symbol || backtestHorizon === null || confidence === null || stake === null || payoutRate === null) {
      setError('Select a live market and registry horizon, then provide minimum confidence, stake, and payout rate.');
      return;
    }
    setLoading(true); setError(null); setResult(null);
    try {
      const response = await fetch('/api/admin/backtest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol, horizonSecs: backtestHorizon, minConfidence: confidence, stake, payoutRate }) });
      const data = await response.json();
      if (!response.ok || !data?.success) throw new Error(data?.error || 'Backtest failed.');
      setResult(data);
      await persistExperiment('backtest', { horizonSecs: backtestHorizon, minConfidence: confidence, stake, payoutRate, selectedSymbolName }, data, backtestHorizon);
    } catch (err: any) { setError(err?.message || 'Backtest failed.'); }
    finally { setLoading(false); }
  };

  const runMultiHorizon = async () => {
    if (!symbol || horizons.length === 0) { setError('No live model-registry horizons are available for multi-horizon evaluation.'); return; }
    setLoading(true); setError(null); setResult(null);
    try {
      const response = await fetch('/api/ml/backtest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol, horizons }) });
      const data = await response.json();
      if (!response.ok || !data?.success) throw new Error(data?.error || 'Multi-horizon evaluation failed.');
      setResult(data);
      const bestHorizon = asNumber(data?.bestHorizon) ?? undefined;
      await persistExperiment('multi-horizon', { horizons, selectedSymbolName }, data, bestHorizon);
    } catch (err: any) { setError(err?.message || 'Multi-horizon evaluation failed.'); }
    finally { setLoading(false); }
  };

  const runPaperShadow = async () => {
    if (!symbol || duration === null || !Number.isFinite(duration) || duration < 1) { setError('Select a live market and provide a valid prediction duration.'); return; }
    setLoading(true); setError(null); setResult(null);
    try {
      const response = await fetch('/api/ml/predict', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol, durationSecs: duration, assetCategory: symbol.startsWith('FRX') ? 1 : symbol.startsWith('CWM') ? 2 : 0 }) });
      const data = await response.json();
      if (!response.ok || !data?.prediction) throw new Error(data?.error || 'Paper/shadow prediction failed.');
      const paperResult = { prediction: data.prediction, ensemble: data.multiModelEnsemble || data.prediction?.ensemble || null };
      setResult(paperResult);
      await persistExperiment('paper-shadow', { durationSecs: duration, selectedSymbolName, executionMode: 'PAPER/SHADOW' }, paperResult, duration);
    } catch (err: any) { setError(err?.message || 'Paper/shadow prediction failed.'); }
    finally { setLoading(false); }
  };

  const runCurrent = () => tab === 'backtest' ? runBacktest() : tab === 'multi-horizon' ? runMultiHorizon() : runPaperShadow();
  const typeLabel = (type: string) => type === 'backtest' ? 'BACKTEST' : type === 'multi-horizon' ? 'MULTI-HORIZON' : 'PAPER / SHADOW';

  return <main className="min-h-screen bg-[#05070b] px-4 py-5 text-slate-100 sm:px-6 lg:px-8"><div className="mx-auto max-w-[1500px]">
    <header className="mb-6 flex flex-col gap-4 rounded-3xl border border-white/10 bg-white/[0.03] p-5 backdrop-blur-xl sm:flex-row sm:items-center sm:justify-between"><div className="flex items-center gap-3"><Link href="/admin" className="rounded-xl border border-white/10 bg-white/5 p-2 text-slate-300 hover:bg-white/10"><ArrowLeft className="h-5 w-5" /></Link><div className="rounded-2xl border border-cyan-400/20 bg-cyan-400/10 p-3"><FlaskConical className="h-6 w-6 text-cyan-300" /></div><div><p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan-300">5B-5</p><h1 className="text-2xl font-black sm:text-3xl">Testing & Research</h1><p className="mt-1 text-xs text-slate-500">Controlled evaluation environment — production execution is never implied.</p></div></div><div className="flex flex-wrap items-center gap-2"><span className="inline-flex items-center gap-2 rounded-full border border-emerald-400/20 bg-emerald-400/10 px-3 py-1.5 text-[10px] font-bold tracking-wider text-emerald-300"><Database className="h-3.5 w-3.5" />{dataSource === 'live-database' ? 'LIVE DATABASE' : dataSource === 'unavailable' ? 'DATABASE UNAVAILABLE' : 'CHECKING DATA'}</span><button onClick={() => { void loadHistory(); void loadSymbols(); void loadRegistryHorizons(); }} disabled={historyLoading} className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-slate-300 hover:bg-white/10 disabled:opacity-50"><RefreshCw className={`h-4 w-4 ${historyLoading ? 'animate-spin' : ''}`} />Refresh</button></div></header>

    <section className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><div className="rounded-2xl border border-cyan-400/15 bg-cyan-400/[0.04] p-4"><div className="mb-2 flex items-center gap-2 text-xs font-semibold text-cyan-300"><Target className="h-4 w-4" />EVALUATION</div><p className="text-sm text-slate-400">Backtests and historical model evaluations use the existing server-side APIs.</p></div><div className="rounded-2xl border border-purple-400/15 bg-purple-400/[0.04] p-4"><div className="mb-2 flex items-center gap-2 text-xs font-semibold text-purple-300"><Beaker className="h-4 w-4" />EXPERIMENTS</div><p className="text-sm text-slate-400">Each completed run receives a persistent experiment ID.</p></div><div className="rounded-2xl border border-amber-400/15 bg-amber-400/[0.04] p-4"><div className="mb-2 flex items-center gap-2 text-xs font-semibold text-amber-300"><ShieldCheck className="h-4 w-4" />PAPER / SHADOW</div><p className="text-sm text-slate-400">Prediction-only testing. No contract is purchased or executed here.</p></div><div className="rounded-2xl border border-emerald-400/15 bg-emerald-400/[0.04] p-4"><div className="mb-2 flex items-center gap-2 text-xs font-semibold text-emerald-300"><History className="h-4 w-4" />HISTORY</div><p className="text-sm text-slate-400">Results are stored in Neon when the database is available.</p></div></section>

    <nav className="mb-5 grid grid-cols-2 gap-2 rounded-2xl border border-white/10 bg-white/[0.025] p-2 sm:grid-cols-4">{([['backtest', 'Historical Backtest', TestTube2], ['multi-horizon', 'Multi-Horizon', Clock3], ['paper-shadow', 'Paper / Shadow', Radio], ['history', 'Experiment History', History]] as const).map(([id, label, Icon]) => <button key={id} onClick={() => { setTab(id); setError(null); }} className={`flex items-center justify-center gap-2 rounded-xl px-3 py-3 text-xs font-semibold transition ${tab === id ? 'bg-cyan-400 text-slate-950' : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'}`}><Icon className="h-4 w-4" />{label}</button>)}</nav>

    {tab !== 'history' && <section className="grid gap-5 lg:grid-cols-[360px_1fr]"><aside className="rounded-2xl border border-white/10 bg-white/[0.025] p-5"><h2 className="text-base font-bold">Experiment Controls</h2><p className="mt-1 text-xs leading-5 text-slate-500">Parameters are sent to the existing production API contracts. No synthetic metrics are generated in the UI.</p><label className="mt-5 block text-xs font-semibold uppercase tracking-wider text-slate-500">Market</label><select value={symbol} onChange={(e) => setSymbol(e.target.value)} className="mt-2 w-full rounded-xl border border-white/10 bg-black/30 px-3 py-3 text-sm outline-none focus:border-cyan-400/40"><option value="">Select live market</option>{symbols.map((item) => <option key={item.symbol} value={item.symbol}>{item.displayName || item.name || item.symbol}</option>)}</select>
      {tab === 'backtest' && <><label className="mt-5 block text-xs font-semibold uppercase tracking-wider text-slate-500">Model horizon</label><select value={backtestHorizon ?? ''} onChange={(e) => setBacktestHorizon(e.target.value === '' ? null : Number(e.target.value))} className="mt-2 w-full rounded-xl border border-white/10 bg-black/30 px-3 py-3 text-sm"><option value="">Select registry horizon</option>{horizons.map((h) => <option key={h} value={h}>{h}s</option>)}</select><label className="mt-5 block text-xs font-semibold uppercase tracking-wider text-slate-500">Minimum confidence (%)</label><input type="number" min="0" max="100" value={confidence ?? ''} onChange={(e) => setConfidence(e.target.value === '' ? null : Number(e.target.value))} className="mt-2 w-full rounded-xl border border-white/10 bg-black/30 px-3 py-3 text-sm" /><label className="mt-5 block text-xs font-semibold uppercase tracking-wider text-slate-500">Stake</label><input type="number" min="0" step="0.01" value={stake ?? ''} onChange={(e) => setStake(e.target.value === '' ? null : Number(e.target.value))} className="mt-2 w-full rounded-xl border border-white/10 bg-black/30 px-3 py-3 text-sm" /><label className="mt-5 block text-xs font-semibold uppercase tracking-wider text-slate-500">Payout rate (decimal)</label><input type="number" min="0.0001" max="1" step="0.0001" value={payoutRate ?? ''} onChange={(e) => setPayoutRate(e.target.value === '' ? null : Number(e.target.value))} className="mt-2 w-full rounded-xl border border-white/10 bg-black/30 px-3 py-3 text-sm" /></>}
      {tab === 'paper-shadow' && <><label className="mt-5 block text-xs font-semibold uppercase tracking-wider text-slate-500">Prediction duration (seconds)</label><input type="number" min="1" value={duration ?? ''} onChange={(e) => setDuration(e.target.value === '' ? null : Number(e.target.value))} className="mt-2 w-full rounded-xl border border-white/10 bg-black/30 px-3 py-3 text-sm" /></>}
      {tab === 'multi-horizon' && <div className="mt-5 rounded-xl border border-cyan-400/15 bg-cyan-400/[0.04] p-4 text-xs leading-5 text-slate-400">{horizons.length ? <>The live model registry currently exposes <span className="font-semibold text-cyan-200">{horizons.join(' s / ')}s</span> horizons for evaluation.</> : 'No live model-registry horizons are currently available.'}</div>}
      <button onClick={runCurrent} disabled={loading || !symbol || (tab === 'multi-horizon' && horizons.length === 0) || (tab === 'backtest' && (backtestHorizon === null || confidence === null || stake === null || payoutRate === null))} className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-cyan-400 px-4 py-3 text-sm font-bold text-slate-950 hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-60">{loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}{loading ? 'Running evaluation…' : tab === 'backtest' ? 'Run Native Backtest' : tab === 'multi-horizon' ? 'Run Multi-Horizon Evaluation' : 'Run Paper / Shadow Test'}</button></aside>

      <div className="rounded-2xl border border-white/10 bg-white/[0.025] p-5"><div className="flex flex-col gap-2 border-b border-white/10 pb-4 sm:flex-row sm:items-center sm:justify-between"><div><p className="text-xs uppercase tracking-wider text-slate-500">Current target</p><h2 className="text-lg font-bold">{selectedSymbolName}</h2></div>{lastExperimentId && <span className="font-mono text-xs text-emerald-300">{lastExperimentId}</span>}</div>{error && <div className="mt-4 flex items-start gap-3 rounded-xl border border-red-400/20 bg-red-400/[0.05] p-4 text-sm text-red-200"><XCircle className="mt-0.5 h-4 w-4 shrink-0" />{error}</div>}{!result && !loading && !error && <div className="flex min-h-[320px] flex-col items-center justify-center text-center"><TestTube2 className="h-10 w-10 text-slate-700" /><p className="mt-4 text-sm font-semibold text-slate-400">No experiment result loaded</p><p className="mt-1 max-w-md text-xs leading-5 text-slate-600">Run an evaluation to see only the metrics returned by the backend.</p></div>}{loading && <div className="flex min-h-[320px] flex-col items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-cyan-300" /><p className="mt-3 text-sm text-slate-400">Executing against live server APIs…</p></div>}{result && <div className="mt-5 space-y-4"><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><Metric label="Win Rate" value={result.winRate} suffix="%" /><Metric label="Trades" value={result.trades ?? result.totalTradesExecuted ?? result.totalTrades} /><Metric label="Net PnL" value={result.totalProfit} /><Metric label="Profit Factor" value={result.profitFactor} /></div><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><Metric label="Accuracy" value={result.accuracy} suffix="%" /><Metric label="Rejected" value={result.rejected} /><Metric label="Best Horizon" value={result.bestHorizon} suffix="s" /><Metric label="Sample Count" value={result.sampleCount} /></div><div className="rounded-xl border border-white/10 bg-black/20 p-4"><div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500"><CheckCircle2 className="h-4 w-4 text-emerald-300" />Persisted experiment</div><p className="mt-2 font-mono text-sm text-emerald-300">{lastExperimentId || 'Not available'}</p><p className="mt-1 text-xs text-slate-600">The stored record contains the experiment type, symbol, parameters and backend result.</p></div></div>}</div></section>}

    {tab === 'history' && <section className="rounded-2xl border border-white/10 bg-white/[0.025] p-5"><div className="mb-5 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="text-lg font-bold">Experiment History</h2><p className="mt-1 text-xs text-slate-500">Persisted evaluation records from the Neon PostgreSQL database.</p></div><span className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-[10px] font-semibold text-slate-400">{experiments.length} records loaded</span></div>{historyLoading ? <div className="flex min-h-48 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-cyan-300" /></div> : experiments.length === 0 ? <div className="flex min-h-48 flex-col items-center justify-center text-center"><History className="h-8 w-8 text-slate-700" /><p className="mt-3 text-sm text-slate-400">No persisted experiments yet.</p><p className="mt-1 text-xs text-slate-600">Run a backtest, multi-horizon evaluation or paper/shadow test to create one.</p></div> : <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left text-xs"><thead><tr className="border-b border-white/10 text-[10px] uppercase tracking-wider text-slate-600"><th className="px-3 py-3">Experiment</th><th className="px-3 py-3">Type</th><th className="px-3 py-3">Symbol</th><th className="px-3 py-3">Horizon</th><th className="px-3 py-3">Status</th><th className="px-3 py-3">Created</th></tr></thead><tbody>{experiments.map((item) => <tr key={item.experiment_id} className="border-b border-white/5 hover:bg-white/[0.02]"><td className="px-3 py-3 font-mono text-cyan-300">{item.experiment_id}</td><td className="px-3 py-3 text-slate-300">{typeLabel(item.experiment_type)}</td><td className="px-3 py-3 text-slate-300">{item.symbol}</td><td className="px-3 py-3 text-slate-400">{item.horizon_seconds ? `${item.horizon_seconds}s` : '—'}</td><td className="px-3 py-3"><span className="inline-flex items-center gap-1.5 text-emerald-300"><CheckCircle2 className="h-3.5 w-3.5" />{item.status}</span></td><td className="px-3 py-3 text-slate-500">{new Date(item.created_at).toLocaleString()}</td></tr>)}</tbody></table></div>}</section>}
  </div></main>;
}
