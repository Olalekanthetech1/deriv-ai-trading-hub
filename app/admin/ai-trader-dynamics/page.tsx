'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Bot,
  BrainCircuit,
  CheckCircle2,
  Clock3,
  DollarSign,
  Power,
  RefreshCw,
  ShieldAlert,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';

interface Trade {
  id: string;
  asset_symbol: string;
  contract_type: string;
  stake: number;
  payout: number | null;
  status: string;
  model_id: string | null;
  executed_at: string;
  settled_at: string | null;
  strategy: string;
  confidence: number | null;
}

interface DynamicsData {
  recentTrades: Trade[];
  stats: {
    totalTrades: number;
    wins: number;
    losses: number;
    netProfit: number;
  };
  drawdown: {
    consecutiveLosses: number;
    activeSequence: string;
    status: 'NORMAL' | 'ELEVATED_RISK';
  };
}

function StatCard({ title, value, subtitle, icon: Icon, color }: { title: string; value: string; subtitle?: string; icon: any; color: 'cyan' | 'emerald' | 'rose' | 'amber' | 'slate' }) {
  const colors = {
    cyan: 'border-cyan-400/20 bg-cyan-400/5 text-cyan-400',
    emerald: 'border-emerald-400/20 bg-emerald-400/5 text-emerald-400',
    rose: 'border-rose-400/20 bg-rose-400/5 text-rose-400',
    amber: 'border-amber-400/20 bg-amber-400/5 text-amber-400',
    slate: 'border-slate-400/20 bg-slate-400/5 text-slate-400',
  };

  return (
    <div className={`flex flex-col gap-2 rounded-2xl border ${colors[color].split(' ')[0]} ${colors[color].split(' ')[1]} p-4`}>
      <div className="flex items-center gap-2">
        <Icon className={`h-4 w-4 ${colors[color].split(' ')[2]}`} />
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">{title}</h3>
      </div>
      <p className="text-2xl font-black text-slate-100">{value}</p>
      {subtitle && <p className="text-[10px] text-slate-500">{subtitle}</p>}
    </div>
  );
}

export default function AITraderDynamicsPage() {
  const [data, setData] = useState<DynamicsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cbStatus, setCbStatus] = useState<any>(null);
  const [cbLoading, setCbLoading] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/ai-trader-dynamics', {
        headers: {
          'x-admin-token': localStorage.getItem('admin_token') || '',
        },
      });
      if (!res.ok) {
        throw new Error(`API Error: ${res.status}`);
      }
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'Failed to load data');
      setData(json.data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadCircuitBreaker = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/circuit-breaker', {
        headers: { 'x-admin-token': localStorage.getItem('admin_token') || '' },
      });
      const json = await res.json();
      if (json.success) {
        setCbStatus(json.overview);
      }
    } catch (e) {}
  }, []);

  useEffect(() => {
    loadData();
    loadCircuitBreaker();
    const interval = setInterval(() => {
      loadData();
      loadCircuitBreaker();
    }, 10000);
    return () => clearInterval(interval);
  }, [loadData, loadCircuitBreaker]);

  const triggerCircuitBreaker = async () => {
    if (!confirm('Are you sure you want to trigger the Circuit Breaker manually? This will evaluate drift and potentially demote active models.')) return;
    setCbLoading(true);
    try {
      const res = await fetch('/api/admin/circuit-breaker', {
        method: 'POST',
        headers: {
          'x-admin-token': localStorage.getItem('admin_token') || '',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ autoDemote: true })
      });
      const json = await res.json();
      if (json.success) {
        alert('Circuit breaker evaluation triggered successfully.');
        loadCircuitBreaker();
      } else {
        alert('Error: ' + json.error);
      }
    } catch (err: any) {
      alert('Error triggering circuit breaker: ' + err.message);
    } finally {
      setCbLoading(false);
    }
  };

  return (
    <main className="min-h-screen bg-[#020617] text-slate-300">
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <header className="mb-8">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h1 className="text-2xl font-extrabold tracking-tight text-white flex items-center gap-2">
                <BrainCircuit className="h-6 w-6 text-cyan-400" />
                AI Trader Dynamics
              </h1>
              <p className="mt-1 text-sm text-slate-400">
                Algorithmic staking observability, active sequences, real-time drawdowns, and Circuit Breaker controls.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Link href="/admin" className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-slate-300 hover:bg-white/10">
                <ArrowLeft className="h-4 w-4" /> Admin Center
              </Link>
              <button onClick={loadData} disabled={loading} className="inline-flex items-center gap-2 rounded-xl border border-cyan-400/20 bg-cyan-400/5 px-3 py-2 text-xs font-semibold text-cyan-200 hover:bg-cyan-400/10 disabled:opacity-60">
                <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
              </button>
            </div>
          </div>
        </header>

        {error ? (
          <div className="mb-6 rounded-xl border border-rose-400/20 bg-rose-400/5 p-4 text-sm text-rose-200">
            {error}
          </div>
        ) : !data && loading ? (
          <div className="flex items-center justify-center p-12 text-sm text-slate-500">
            <RefreshCw className="h-4 w-4 animate-spin mr-2" /> Loading telemetry...
          </div>
        ) : data && (
          <>
            <section className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard
                title="Total AI Trades"
                value={data.stats.totalTrades.toString()}
                icon={Activity}
                color="cyan"
              />
              <StatCard
                title="Win Rate"
                value={data.stats.totalTrades > 0 ? `${Math.round((data.stats.wins / data.stats.totalTrades) * 100)}%` : '0%'}
                subtitle={`${data.stats.wins} W / ${data.stats.losses} L`}
                icon={CheckCircle2}
                color={data.stats.wins > data.stats.losses ? 'emerald' : 'amber'}
              />
              <StatCard
                title="Net Profit"
                value={`${data.stats.netProfit >= 0 ? '+' : ''}$${data.stats.netProfit.toFixed(2)}`}
                icon={DollarSign}
                color={data.stats.netProfit >= 0 ? 'emerald' : 'rose'}
              />
              <StatCard
                title="Drawdown State"
                value={data.drawdown.activeSequence}
                subtitle={`${data.drawdown.consecutiveLosses} consecutive losses`}
                icon={data.drawdown.consecutiveLosses > 0 ? TrendingDown : TrendingUp}
                color={data.drawdown.consecutiveLosses >= 3 ? 'rose' : data.drawdown.consecutiveLosses > 0 ? 'amber' : 'emerald'}
              />
            </section>

            <section className="mb-8 rounded-2xl border border-white/10 bg-white/[0.025] p-6">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
                <div>
                  <h2 className="text-lg font-bold text-slate-100 flex items-center gap-2">
                    <Power className="h-5 w-5 text-rose-400" />
                    Global Circuit Breaker
                  </h2>
                  <p className="mt-1 text-xs text-slate-400">
                    Monitors model drift and consecutive losses to automatically halt algorithmic trading.
                  </p>
                </div>
                <button
                  onClick={triggerCircuitBreaker}
                  disabled={cbLoading}
                  className="inline-flex items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-2 text-xs font-bold text-rose-300 hover:bg-rose-500/20 transition disabled:opacity-50 shadow-[0_0_15px_rgba(244,63,94,0.1)]"
                >
                  <ShieldAlert className="h-4 w-4" />
                  {cbLoading ? 'Evaluating...' : 'Force Evaluation & Halt'}
                </button>
              </div>

              {cbStatus ? (
                <div className="grid gap-4 md:grid-cols-3">
                  <div className="rounded-xl border border-white/5 bg-black/20 p-4">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Active Models</p>
                    <p className="mt-1 text-xl font-bold text-slate-200">{cbStatus.productionModelsCount}</p>
                  </div>
                  <div className="rounded-xl border border-white/5 bg-black/20 p-4">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Predictions Tracked</p>
                    <p className="mt-1 text-xl font-bold text-slate-200">{cbStatus.recentEventsCount}</p>
                  </div>
                  <div className="rounded-xl border border-white/5 bg-black/20 p-4">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Demoted Models</p>
                    <p className="mt-1 text-xl font-bold text-slate-200">{cbStatus.demotedModelsCount}</p>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-slate-500">Loading circuit breaker status...</p>
              )}
            </section>

            <section className="rounded-2xl border border-white/10 bg-white/[0.025] overflow-hidden">
              <div className="border-b border-white/10 p-4">
                <h2 className="text-sm font-bold text-slate-100 flex items-center gap-2">
                  <Bot className="h-4 w-4 text-cyan-400" />
                  Recent Algorithmic Executions
                </h2>
              </div>
              
              {data.recentTrades.length === 0 ? (
                <div className="p-12 text-center text-sm text-slate-500">
                  No AI trades executed yet.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs text-slate-400">
                    <thead className="border-b border-white/5 bg-black/20 text-[10px] uppercase tracking-wider">
                      <tr>
                        <th className="px-4 py-3 font-semibold">Executed At</th>
                        <th className="px-4 py-3 font-semibold">Asset</th>
                        <th className="px-4 py-3 font-semibold">Type</th>
                        <th className="px-4 py-3 font-semibold">Strategy</th>
                        <th className="px-4 py-3 font-semibold text-right">Stake</th>
                        <th className="px-4 py-3 font-semibold text-right">Payout</th>
                        <th className="px-4 py-3 font-semibold">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                      {data.recentTrades.map(trade => (
                        <tr key={trade.id} className="transition hover:bg-white/[0.02]">
                          <td className="px-4 py-3 whitespace-nowrap">
                            {new Date(trade.executed_at).toLocaleString()}
                          </td>
                          <td className="px-4 py-3 font-mono text-slate-300">
                            {trade.asset_symbol}
                          </td>
                          <td className="px-4 py-3">
                            <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold ${trade.contract_type === 'CALL' ? 'bg-emerald-400/10 text-emerald-400' : 'bg-rose-400/10 text-rose-400'}`}>
                              {trade.contract_type}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            <span className="text-slate-300">{trade.strategy || 'AI Signal'}</span>
                            {trade.confidence && <span className="ml-2 text-cyan-500/70">{(trade.confidence * 100).toFixed(1)}% conf</span>}
                          </td>
                          <td className="px-4 py-3 text-right font-mono text-slate-300">
                            ${Number(trade.stake).toFixed(2)}
                          </td>
                          <td className="px-4 py-3 text-right font-mono text-slate-300">
                            {trade.payout ? `$${Number(trade.payout).toFixed(2)}` : '-'}
                          </td>
                          <td className="px-4 py-3">
                            <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold ${
                              trade.status === 'WON' || trade.status === 'WIN' ? 'bg-emerald-400/10 text-emerald-400 border border-emerald-400/20' :
                              trade.status === 'LOST' || trade.status === 'LOSS' ? 'bg-rose-400/10 text-rose-400 border border-rose-400/20' :
                              'bg-amber-400/10 text-amber-400 border border-amber-400/20'
                            }`}>
                              {trade.status}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </main>
  );
}
