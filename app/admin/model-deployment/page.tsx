'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import Link from 'next/link';
import { adminFetch } from '@/lib/admin-client-auth';
import {
  Rocket,
  ShieldCheck,
  BrainCircuit,
  ArrowLeft,
  RefreshCw,
  Sparkles,
  CheckCircle2,
  AlertTriangle,
  Layers,
  ChevronRight,
  TrendingUp,
  Database,
  Search,
  Filter,
  Trash2,
} from 'lucide-react';
import { AssetBatchPresets } from '@/components/admin/asset-batch-presets';
import { CircuitBreakerPanel } from '@/components/custom/circuit-breaker-panel';

interface CandidateModel {
  modelId: string;
  modelFamily: string;
  symbol: string;
  horizonTicks: number;
  format: string;
  status: string;
  metrics: any;
  accuracy: number | null;
  f1: number | null;
  createdAt: string;
  updatedAt: string;
  hasArtifact: boolean;
}

interface FleetAsset {
  symbol: string;
  displayName: string;
  market: string;
  submarket: string;
  hasProductionModel: boolean;
  productionCount: number;
  candidateCount: number;
  activeModels: {
    modelId: string;
    modelFamily: string;
    version: string;
    horizonTicks: number;
    accuracy: number | null;
    f1: number | null;
    updatedAt: string;
  }[];
}

export default function ModelDeploymentHubPage() {
  const [fleet, setFleet] = useState<FleetAsset[]>([]);
  const [candidates, setCandidates] = useState<CandidateModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activatingId, setActivatingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [purging, setPurging] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [marketFilter, setMarketFilter] = useState<'ALL' | 'SYNTHETIC' | 'FOREX'>('ALL');
  const [readyFilter, setReadyFilter] = useState<'ALL' | 'READY' | 'UNREADY'>('ALL');
  const [successNotice, setSuccessNotice] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [counts, setCounts] = useState<{
    totalModels: number;
    production: number;
    candidates: number;
    retired: number;
    assetsCovered: number;
    totalAssets: number;
  }>({
    totalModels: 0,
    production: 0,
    candidates: 0,
    retired: 0,
    assetsCovered: 0,
    totalAssets: 0,
  });

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    setErrorMessage(null);
    try {
      const res = await adminFetch('/api/admin/model-activation', { cache: 'no-store' });
      if (res.status === 401) {
        window.location.replace('/admin');
        return;
      }
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to load model deployment catalog');
      }
      setFleet(data.fleetStatus || []);
      setCandidates(data.candidates || []);
      if (data.counts) setCounts(data.counts);
    } catch (e: any) {
      setErrorMessage(e.message || 'Unable to connect to model activation service');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(() => load(false), 30000);
    return () => clearInterval(interval);
  }, [load]);

  const handleActivate = async (candidate: CandidateModel) => {
    setActivatingId(candidate.modelId);
    setSuccessNotice(null);
    setErrorMessage(null);

    try {
      const res = await adminFetch('/api/admin/model-activation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modelId: candidate.modelId,
          symbol: candidate.symbol,
          horizonTicks: candidate.horizonTicks,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to activate model');
      }

      setSuccessNotice(data.message || `Model ${candidate.modelId} successfully activated for live trading.`);
      await load(true);
    } catch (e: any) {
      setErrorMessage(e.message || 'Model activation failed');
    } finally {
      setActivatingId(null);
    }
  };

  const handleDeleteCandidate = async (candidate: CandidateModel) => {
    if (!confirm(`Are you sure you want to delete candidate model "${candidate.modelId}"?`)) return;
    setDeletingId(candidate.modelId);
    setSuccessNotice(null);
    setErrorMessage(null);

    try {
      const res = await adminFetch('/api/admin/model-cleanup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modelIds: [candidate.modelId],
          confirm: true,
          force: true,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to delete candidate model');
      }

      setSuccessNotice(`Candidate model ${candidate.modelId} successfully removed.`);
      await load(true);
    } catch (e: any) {
      setErrorMessage(e.message || 'Model deletion failed');
    } finally {
      setDeletingId(null);
    }
  };

  const handlePurgeMissingArtifacts = async () => {
    if (!confirm('Purge all candidate models that do NOT have binary artifact files (.pkl)?')) return;
    setPurging(true);
    setSuccessNotice(null);
    setErrorMessage(null);

    try {
      const res = await adminFetch('/api/admin/model-cleanup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          purgeMissingArtifacts: true,
          confirm: true,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to purge candidate models');
      }

      setSuccessNotice(data.message || `Purged candidate models without artifacts.`);
      await load(true);
    } catch (e: any) {
      setErrorMessage(e.message || 'Purging failed');
    } finally {
      setPurging(false);
    }
  };

  const filteredFleet = useMemo(() => {
    return fleet.filter((asset) => {
      const matchesSearch =
        !searchQuery ||
        asset.symbol.toLowerCase().includes(searchQuery.toLowerCase()) ||
        asset.displayName.toLowerCase().includes(searchQuery.toLowerCase());

      const matchesMarket =
        marketFilter === 'ALL' ||
        (marketFilter === 'SYNTHETIC' && (asset.market === 'synthetic_index' || asset.symbol.startsWith('R_') || asset.symbol.startsWith('1HZ'))) ||
        (marketFilter === 'FOREX' && (asset.market === 'forex' || asset.symbol.startsWith('frx')));

      const matchesReady =
        readyFilter === 'ALL' ||
        (readyFilter === 'READY' && asset.hasProductionModel) ||
        (readyFilter === 'UNREADY' && !asset.hasProductionModel);

      return matchesSearch && matchesMarket && matchesReady;
    });
  }, [fleet, searchQuery, marketFilter, readyFilter]);

  const filteredCandidates = useMemo(() => {
    return candidates.filter((cand) => {
      if (!searchQuery) return true;
      const q = searchQuery.toLowerCase();
      return (
        cand.symbol.toLowerCase().includes(q) ||
        cand.modelId.toLowerCase().includes(q) ||
        cand.modelFamily.toLowerCase().includes(q)
      );
    });
  }, [candidates, searchQuery]);

  const missingArtifactCount = useMemo(() => {
    return candidates.filter((cand) => !cand.hasArtifact).length;
  }, [candidates]);

  return (
    <main className="min-h-screen bg-[#05070b] text-slate-100 pb-20">
      <div className="mx-auto max-w-[1600px] px-4 py-6 sm:px-6 lg:px-8 space-y-6">
        {/* Navigation & Header */}
        <header className="flex flex-col gap-4 rounded-3xl border border-white/10 bg-white/[0.03] p-5 backdrop-blur-xl sm:flex-row sm:items-center sm:justify-between">
          <div>
            <Link
              href="/admin"
              className="mb-2 inline-flex items-center gap-2 text-xs text-slate-400 hover:text-slate-200 transition"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Back to Operations Center
            </Link>
            <div className="flex items-center gap-3">
              <div className="rounded-2xl border border-cyan-400/20 bg-cyan-400/10 p-3">
                <Rocket className="h-6 w-6 text-cyan-300" />
              </div>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-cyan-300">
                  Admin AI / ML Control
                </p>
                <h1 className="text-2xl font-black tracking-tight sm:text-3xl">
                  Model Deployment & Live Activation Hub
                </h1>
                <p className="mt-1 text-xs text-slate-400">
                  Directly activate any trained candidate model as the Live Production Champion with one click.
                </p>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href="/admin/training-pipeline"
              className="inline-flex items-center gap-2 rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-3.5 py-2 text-xs font-semibold text-cyan-200 hover:bg-cyan-500/20 transition cursor-pointer"
            >
              <BrainCircuit className="h-4 w-4" />
              Train New Models
            </Link>
            <Link
              href="/admin/models"
              className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3.5 py-2 text-xs font-semibold text-slate-300 hover:bg-white/10 transition cursor-pointer"
            >
              <Database className="h-4 w-4" />
              Full Registry
            </Link>
            <button
              onClick={() => load(true)}
              disabled={refreshing || loading}
              className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3.5 py-2 text-xs font-semibold text-slate-300 hover:bg-white/10 transition cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
        </header>

        {/* Notices */}
        {successNotice && (
          <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-xs font-medium text-emerald-300 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              <span>{successNotice}</span>
            </div>
            <button
              onClick={() => setSuccessNotice(null)}
              className="text-emerald-400 hover:text-emerald-200 text-xs underline cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        )}

        {errorMessage && (
          <div className="rounded-2xl border border-rose-500/30 bg-rose-500/10 p-4 text-xs font-medium text-rose-300 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span>{errorMessage}</span>
            </div>
            <button
              onClick={() => setErrorMessage(null)}
              className="text-rose-400 hover:text-rose-200 text-xs underline cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Overview Stats Bento Grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="rounded-3xl border border-white/10 bg-white/[0.025] p-4 space-y-1">
            <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Live Assets Covered</span>
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-black text-emerald-400">{counts.assetsCovered}</span>
              <span className="text-xs text-slate-500">/ {counts.totalAssets} assets</span>
            </div>
            <p className="text-[10px] text-slate-500">Assets with active Production models</p>
          </div>

          <div className="rounded-3xl border border-white/10 bg-white/[0.025] p-4 space-y-1">
            <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Trained Candidates</span>
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-black text-cyan-400">{counts.candidates}</span>
              <span className="text-xs text-slate-500">ready to activate</span>
            </div>
            <p className="text-[10px] text-slate-500">Past & newly trained models in database</p>
          </div>

          <div className="rounded-3xl border border-white/10 bg-white/[0.025] p-4 space-y-1">
            <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Active Production Models</span>
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-black text-slate-100">{counts.production}</span>
              <span className="text-xs text-slate-500">live champions</span>
            </div>
            <p className="text-[10px] text-slate-500">Currently serving inference</p>
          </div>

          <div className="rounded-3xl border border-white/10 bg-white/[0.025] p-4 space-y-1">
            <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Total Model Fleet</span>
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-black text-slate-100">{counts.totalModels}</span>
              <span className="text-xs text-slate-500">records</span>
            </div>
            <p className="text-[10px] text-slate-500">All registered versions in PostgreSQL</p>
          </div>
        </div>

        {/* Section 1: Trained Models Awaiting Activation */}
        <section className="rounded-3xl border border-white/10 bg-white/[0.025] p-6 space-y-5">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <Sparkles className="h-5 w-5 text-cyan-400" />
                <h2 className="text-lg font-bold text-slate-100">
                  Trained Models Ready for Activation ({filteredCandidates.length})
                </h2>
              </div>
              <p className="mt-1 text-xs text-slate-400">
                Click <strong>"Activate for Live Analysis"</strong> on any candidate below to instantly register it as the production champion.
              </p>
            </div>
            <div className="relative w-full md:w-72">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-500" />
              <input
                type="text"
                placeholder="Filter by symbol, model ID..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full rounded-xl border border-white/10 bg-black/40 pl-9 pr-3 py-2 text-xs text-slate-200 placeholder-slate-500 focus:border-cyan-400 focus:outline-none"
              />
            </div>
          </div>

          {/* Missing Artifacts Alert Banner & Purge Action */}
          {missingArtifactCount > 0 && (
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4">
              <div className="flex items-center gap-3">
                <AlertTriangle className="h-5 w-5 text-amber-400 shrink-0" />
                <div>
                  <p className="text-xs font-bold text-amber-200">
                    {missingArtifactCount} Candidate Model{missingArtifactCount === 1 ? '' : 's'} Missing Binary Files (.pkl)
                  </p>
                  <p className="text-[11px] text-amber-300/80">
                    These entries exist in metadata but lack model weights and cannot be activated for live trading.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={handlePurgeMissingArtifacts}
                disabled={purging}
                className="inline-flex items-center gap-1.5 rounded-xl border border-amber-400/30 bg-amber-400/20 px-3.5 py-2 text-xs font-bold text-amber-100 hover:bg-amber-400/30 transition disabled:opacity-50 shrink-0 cursor-pointer shadow-lg shadow-amber-950/40"
              >
                {purging ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                Purge All Missing ({missingArtifactCount})
              </button>
            </div>
          )}

          {loading ? (
            <div className="py-12 text-center text-xs text-slate-500 flex items-center justify-center gap-2">
              <RefreshCw className="h-4 w-4 animate-spin text-cyan-400" />
              Loading trained models from registry...
            </div>
          ) : filteredCandidates.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-white/10 p-8 text-center space-y-3">
              <BrainCircuit className="h-8 w-8 text-slate-600 mx-auto" />
              <p className="text-xs text-slate-400">No candidate models currently waiting for activation.</p>
              <Link
                href="/admin/training-pipeline"
                className="inline-flex items-center gap-2 rounded-xl bg-cyan-400 px-4 py-2 text-xs font-bold text-slate-950 hover:bg-cyan-300 transition"
              >
                Go to Training Pipeline
              </Link>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredCandidates.map((cand) => (
                <div
                  key={cand.modelId}
                  className="rounded-2xl border border-cyan-500/20 bg-cyan-950/10 p-4 space-y-3 flex flex-col justify-between transition hover:border-cyan-500/40"
                >
                  <div className="space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <span className="inline-block rounded-md bg-cyan-500/20 px-2 py-0.5 text-[11px] font-bold text-cyan-300 font-mono">
                          {cand.symbol}
                        </span>
                        <span className="ml-2 text-xs font-medium text-slate-400">
                          {cand.horizonTicks ? `${cand.horizonTicks} ticks` : 'Multi-Horizon'}
                        </span>
                      </div>
                      <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] font-semibold text-slate-300 uppercase">
                        {cand.modelFamily}
                      </span>
                    </div>

                    <p className="text-[11px] font-mono text-slate-400 truncate" title={cand.modelId}>
                      ID: {cand.modelId}
                    </p>

                    {/* Metrics Badge */}
                    <div className="grid grid-cols-2 gap-2 pt-1">
                      <div className="rounded-xl border border-white/5 bg-black/40 p-2">
                        <span className="text-[10px] text-slate-500 block">Val Accuracy</span>
                        <span className="text-xs font-bold text-emerald-400">
                          {cand.accuracy !== null
                            ? `${(cand.accuracy > 1 ? cand.accuracy : cand.accuracy * 100).toFixed(1)}%`
                            : '—'}
                        </span>
                      </div>
                      <div className="rounded-xl border border-white/5 bg-black/40 p-2">
                        <span className="text-[10px] text-slate-500 block">F1 Score</span>
                        <span className="text-xs font-bold text-cyan-300">
                          {cand.f1 !== null
                            ? (cand.f1 > 1 ? cand.f1 : cand.f1 * 100).toFixed(1)
                            : '—'}
                        </span>
                      </div>
                    </div>

                    {!cand.hasArtifact && (
                      <div className="flex items-center gap-1.5 rounded-lg border border-amber-400/20 bg-amber-400/10 px-2.5 py-1 text-[11px] font-semibold text-amber-300">
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                        <span>Binary Artifact Missing (.pkl)</span>
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleDeleteCandidate(cand)}
                      disabled={deletingId === cand.modelId}
                      title="Delete candidate model record"
                      className="flex items-center justify-center p-2.5 rounded-xl border border-rose-500/30 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20 transition disabled:opacity-50 cursor-pointer shrink-0"
                    >
                      {deletingId === cand.modelId ? (
                        <RefreshCw className="h-4 w-4 animate-spin" />
                      ) : (
                        <Trash2 className="h-4 w-4" />
                      )}
                    </button>

                    <button
                      type="button"
                      onClick={() => handleActivate(cand)}
                      disabled={activatingId === cand.modelId || !cand.hasArtifact}
                      title={!cand.hasArtifact ? "Cannot activate: binary model weights (.pkl) file is missing from database storage." : "Activate as Production Champion"}
                      className={`flex-1 flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-xs font-bold transition ${
                        !cand.hasArtifact
                          ? 'bg-slate-800/80 text-slate-400 border border-white/5 cursor-not-allowed shadow-none'
                          : 'bg-cyan-400 text-slate-950 hover:bg-cyan-300 disabled:opacity-50 cursor-pointer shadow-lg shadow-cyan-950/50'
                      }`}
                    >
                      {activatingId === cand.modelId ? (
                        <>
                          <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                          Activating...
                        </>
                      ) : !cand.hasArtifact ? (
                        <>
                          <AlertTriangle className="h-3.5 w-3.5" />
                          Missing Artifact (.pkl)
                        </>
                      ) : (
                        <>
                          <Rocket className="h-3.5 w-3.5" />
                          Activate Champion
                        </>
                      )}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Section 2: Asset Fleet Readiness Matrix */}
        <section className="rounded-3xl border border-white/10 bg-white/[0.025] p-6 space-y-5">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <ShieldCheck className="h-5 w-5 text-emerald-400" />
                <h2 className="text-lg font-bold text-slate-100">
                  Asset Fleet Readiness Matrix ({filteredFleet.length})
                </h2>
              </div>
              <p className="mt-1 text-xs text-slate-400">
                Complete overview of active production models across all synthetic and forex markets.
              </p>
            </div>

            {/* Filter Buttons */}
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex rounded-xl border border-white/10 bg-black/40 p-0.5 text-xs">
                <button
                  type="button"
                  onClick={() => setMarketFilter('ALL')}
                  className={`px-3 py-1.5 rounded-lg transition cursor-pointer ${marketFilter === 'ALL' ? 'bg-cyan-500/20 text-cyan-300 font-bold' : 'text-slate-400 hover:text-slate-200'}`}
                >
                  All Markets
                </button>
                <button
                  type="button"
                  onClick={() => setMarketFilter('SYNTHETIC')}
                  className={`px-3 py-1.5 rounded-lg transition cursor-pointer ${marketFilter === 'SYNTHETIC' ? 'bg-cyan-500/20 text-cyan-300 font-bold' : 'text-slate-400 hover:text-slate-200'}`}
                >
                  Synthetics
                </button>
                <button
                  type="button"
                  onClick={() => setMarketFilter('FOREX')}
                  className={`px-3 py-1.5 rounded-lg transition cursor-pointer ${marketFilter === 'FOREX' ? 'bg-cyan-500/20 text-cyan-300 font-bold' : 'text-slate-400 hover:text-slate-200'}`}
                >
                  Forex
                </button>
              </div>

              <div className="flex rounded-xl border border-white/10 bg-black/40 p-0.5 text-xs">
                <button
                  type="button"
                  onClick={() => setReadyFilter('ALL')}
                  className={`px-3 py-1.5 rounded-lg transition cursor-pointer ${readyFilter === 'ALL' ? 'bg-emerald-500/20 text-emerald-300 font-bold' : 'text-slate-400 hover:text-slate-200'}`}
                >
                  All ({fleet.length})
                </button>
                <button
                  type="button"
                  onClick={() => setReadyFilter('READY')}
                  className={`px-3 py-1.5 rounded-lg transition cursor-pointer ${readyFilter === 'READY' ? 'bg-emerald-500/20 text-emerald-300 font-bold' : 'text-slate-400 hover:text-slate-200'}`}
                >
                  Ready ({fleet.filter(f => f.hasProductionModel).length})
                </button>
                <button
                  type="button"
                  onClick={() => setReadyFilter('UNREADY')}
                  className={`px-3 py-1.5 rounded-lg transition cursor-pointer ${readyFilter === 'UNREADY' ? 'bg-amber-500/20 text-amber-300 font-bold' : 'text-slate-400 hover:text-slate-200'}`}
                >
                  Needs Model ({fleet.filter(f => !f.hasProductionModel).length})
                </button>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {filteredFleet.map((asset) => (
              <div
                key={asset.symbol}
                className={`rounded-2xl border p-4 transition space-y-3 ${
                  asset.hasProductionModel
                    ? 'border-emerald-500/30 bg-emerald-950/10'
                    : 'border-white/10 bg-white/[0.02]'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <span className="font-bold text-slate-100 text-sm">{asset.displayName}</span>
                    <span className="block text-[11px] font-mono text-cyan-400">{asset.symbol}</span>
                  </div>
                  <span
                    className={`rounded-full px-2.5 py-1 text-[10px] font-bold ${
                      asset.hasProductionModel
                        ? 'border border-emerald-400/30 bg-emerald-500/20 text-emerald-300'
                        : 'border border-amber-400/30 bg-amber-500/20 text-amber-300'
                    }`}
                  >
                    {asset.hasProductionModel ? 'AI READY' : 'NO ACTIVE MODEL'}
                  </span>
                </div>

                {asset.hasProductionModel ? (
                  <div className="space-y-1.5 rounded-xl border border-emerald-500/10 bg-black/40 p-2.5 text-xs">
                    <span className="text-[10px] font-bold text-emerald-400 uppercase tracking-wider block">
                      Active Champion
                    </span>
                    {asset.activeModels.map((m) => (
                      <div key={m.modelId} className="flex items-center justify-between text-[11px]">
                        <span className="font-mono text-slate-300 truncate max-w-[140px]" title={m.modelId}>
                          {m.modelFamily} ({m.horizonTicks}t)
                        </span>
                        <span className="text-emerald-300 font-bold">
                          {m.accuracy !== null
                            ? `${(m.accuracy > 1 ? m.accuracy : m.accuracy * 100).toFixed(1)}% acc`
                            : 'Active'}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-xl border border-dashed border-white/10 p-3 text-center space-y-2">
                    <span className="text-[11px] text-slate-500 block">
                      {asset.candidateCount > 0
                        ? `${asset.candidateCount} candidate(s) trained`
                        : 'No models trained yet'}
                    </span>
                    {asset.candidateCount > 0 ? (
                      <button
                        type="button"
                        onClick={() => setSearchQuery(asset.symbol)}
                        className="inline-flex items-center gap-1 text-[11px] font-bold text-cyan-400 hover:text-cyan-300 underline cursor-pointer"
                      >
                        Find candidate above & activate
                      </button>
                    ) : (
                      <Link
                        href={`/admin/training-pipeline`}
                        className="inline-flex items-center gap-1 text-[11px] font-bold text-cyan-400 hover:text-cyan-300 underline cursor-pointer"
                      >
                        Train model for {asset.symbol}
                      </Link>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>

        {/* Live Drift & Auto-Demotion Circuit Breaker */}
        <CircuitBreakerPanel />
      </div>
    </main>
  );
}
