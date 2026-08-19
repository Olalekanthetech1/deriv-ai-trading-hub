'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  Activity,
  AlertOctagon,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Cpu,
  Pause,
  Play,
  Power,
  Radio,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Wrench,
} from 'lucide-react';
import { adminFetch } from '@/lib/admin-client-auth';
import type { WorkerSwitchboardState } from '@/lib/worker-control-store';

export default function WorkerControlPage() {
  const [state, setState] = useState<WorkerSwitchboardState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);

  // Form states for individual worker cards
  const [datasetEnabled, setDatasetEnabled] = useState(false);
  const [datasetConcurrency, setDatasetConcurrency] = useState(2);

  const [queuePaused, setQueuePaused] = useState(false);
  const [queueConcurrency, setQueueConcurrency] = useState(2);

  const [retrainingEnabled, setRetrainingEnabled] = useState(false);
  const [retrainingInterval, setRetrainingInterval] = useState(24);
  const [retrainingThreshold, setRetrainingThreshold] = useState(0.55);

  const [cbEnabled, setCbEnabled] = useState(true);
  const [cbAutoDemote, setCbAutoDemote] = useState(true);
  const [cbDriftTolerance, setCbDriftTolerance] = useState(0.48);

  const [tickEnabled, setTickEnabled] = useState(true);
  const [tickMaxSymbols, setTickMaxSymbols] = useState(30);

  const loadState = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true);
    try {
      const res = await adminFetch('/api/admin/worker-control', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Failed to load worker switchboard state');

      const st: WorkerSwitchboardState = data.state;
      setState(st);

      // Populate local form fields from loaded state
      setDatasetEnabled(st.datasetWorker.enabled);
      setDatasetConcurrency(st.datasetWorker.maxConcurrentJobs);

      setQueuePaused(st.trainingQueueWorker.isPaused);
      setQueueConcurrency(st.trainingQueueWorker.concurrencyLimit);

      setRetrainingEnabled(st.retrainingWorker.enabled);
      setRetrainingInterval(st.retrainingWorker.intervalHours);
      setRetrainingThreshold(st.retrainingWorker.minAccuracyThreshold);

      setCbEnabled(st.circuitBreakerWorker.enabled);
      setCbAutoDemote(st.circuitBreakerWorker.autoDemote);
      setCbDriftTolerance(st.circuitBreakerWorker.driftToleranceRatio);

      setTickEnabled(st.tickIngestion.enabled);
      setTickMaxSymbols(st.tickIngestion.maxActiveSymbols);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load worker status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadState(true);
  }, [loadState]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => void loadState(false), 10000);
    return () => clearInterval(interval);
  }, [autoRefresh, loadState]);

  async function postAction(actionPayload: Record<string, any>) {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const res = await adminFetch('/api/admin/worker-control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(actionPayload),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Failed to update worker settings');

      setMessage(data.message || 'Worker configuration saved successfully.');
      if (data.state) {
        setState(data.state);
      } else {
        await loadState(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  }

  async function handleMasterModeChange(newMode: 'manual' | 'autonomous') {
    if (newMode === 'autonomous') {
      const ok = window.confirm(
        'Switching to AUTONOMOUS MODE will allow enabled background queues and automated retraining tasks to execute on schedule. Proceed?'
      );
      if (!ok) return;
    }
    await postAction({ action: 'set_master_mode', mode: newMode });
  }

  async function handleEmergencyHalt() {
    const ok = window.confirm(
      'EMERGENCY HALT: This will immediately stop and cancel ALL running dataset construction jobs and active training runs, pause the queue, and lock the system in MANUAL STANDBY. Continue?'
    );
    if (!ok) return;
    await postAction({ action: 'emergency_halt_all' });
  }

  const isManual = state?.master.mode === 'manual';
  const isHalted = state?.master.globalKillSwitch;

  return (
    <div className="space-y-8 p-6 text-slate-100 max-w-7xl mx-auto">
      {/* Header Banner */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 rounded-3xl border border-white/10 bg-slate-900/80 p-6 backdrop-blur-xl shadow-2xl">
        <div className="space-y-1.5">
          <div className="flex items-center gap-2.5">
            <Cpu className="h-7 w-7 text-cyan-400" />
            <h1 className="text-2xl font-black tracking-tight text-white">
              Automation & Worker Control Center
            </h1>
          </div>
          <p className="text-xs text-slate-400 max-w-2xl">
            Central operational switchboard for background workers, queue scaling, auto-retraining schedules, and emergency kill-switches.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={() => void loadState(true)}
            disabled={loading || saving}
            className="flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/5 px-3.5 py-2 text-xs font-semibold text-slate-300 hover:bg-white/10 hover:text-white transition disabled:opacity-50 cursor-pointer"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>

          <button
            onClick={() => setAutoRefresh(!autoRefresh)}
            className={`flex items-center gap-1.5 rounded-xl border px-3.5 py-2 text-xs font-semibold transition cursor-pointer ${
              autoRefresh
                ? 'border-cyan-500/30 bg-cyan-500/10 text-cyan-300'
                : 'border-white/10 bg-white/5 text-slate-400'
            }`}
          >
            <Activity className="h-4 w-4" />
            {autoRefresh ? 'Live Poll (10s)' : 'Poll Paused'}
          </button>

          <button
            onClick={() => void handleEmergencyHalt()}
            disabled={saving}
            className="flex items-center gap-2 rounded-xl border border-red-500/50 bg-red-600/20 px-4 py-2 text-xs font-bold text-red-200 hover:bg-red-600/30 hover:border-red-500 transition shadow-lg shadow-red-950/40 cursor-pointer disabled:opacity-50"
          >
            <Power className="h-4 w-4 text-red-400" />
            EMERGENCY HALT ALL
          </button>
        </div>
      </div>

      {/* Message & Error Alerts */}
      {error && (
        <div className="flex items-center gap-3 rounded-2xl border border-red-500/40 bg-red-950/40 p-4 text-sm text-red-300 shadow-lg">
          <AlertTriangle className="h-5 w-5 shrink-0 text-red-400" />
          <p className="font-medium">{error}</p>
        </div>
      )}

      {message && (
        <div className="flex items-center gap-3 rounded-2xl border border-emerald-500/40 bg-emerald-950/40 p-4 text-sm text-emerald-300 shadow-lg">
          <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-400" />
          <p className="font-medium">{message}</p>
        </div>
      )}

      {/* Master Mode Switcher Panel */}
      <div className="rounded-3xl border border-white/10 bg-slate-900/60 p-6 backdrop-blur-xl shadow-xl space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-white/10 pb-4">
          <div>
            <h2 className="text-lg font-bold text-white flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-cyan-400" />
              Master Automation Operating Mode
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Control whether background processes execute automatically or remain in manual standby mode.
            </p>
          </div>

          <div className="flex items-center gap-2 rounded-2xl border border-white/10 bg-black/40 p-1.5">
            <button
              onClick={() => void handleMasterModeChange('manual')}
              disabled={saving}
              className={`flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-bold transition cursor-pointer ${
                isManual
                  ? 'bg-amber-500/20 text-amber-200 border border-amber-500/40 shadow-inner'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <Pause className="h-4 w-4 text-amber-400" />
              MANUAL STANDBY (Default)
            </button>

            <button
              onClick={() => void handleMasterModeChange('autonomous')}
              disabled={saving}
              className={`flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-bold transition cursor-pointer ${
                !isManual
                  ? 'bg-emerald-500/20 text-emerald-200 border border-emerald-500/40 shadow-inner'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <Play className="h-4 w-4 text-emerald-400" />
              AUTONOMOUS MODE
            </button>
          </div>
        </div>

        {/* Master Telemetry Quick Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pt-1">
          <div className="rounded-2xl border border-white/5 bg-white/[0.02] p-4">
            <p className="text-[11px] font-semibold text-slate-400">Master State</p>
            <div className="mt-1 flex items-center gap-2">
              <span
                className={`h-2.5 w-2.5 rounded-full ${
                  isHalted ? 'bg-red-500 animate-ping' : isManual ? 'bg-amber-400' : 'bg-emerald-400 animate-pulse'
                }`}
              />
              <span className="font-bold text-sm text-white">
                {isHalted ? 'EMERGENCY HALTED' : isManual ? 'MANUAL STANDBY' : 'AUTONOMOUS ACTIVE'}
              </span>
            </div>
          </div>

          <div className="rounded-2xl border border-white/5 bg-white/[0.02] p-4">
            <p className="text-[11px] font-semibold text-slate-400">Active Dataset Jobs</p>
            <p className="mt-1 text-lg font-black text-cyan-300">
              {state?.telemetry.activeDatasetJobs ?? 0} <span className="text-xs font-normal text-slate-500">running ({state?.telemetry.pendingDatasetJobs ?? 0} pending)</span>
            </p>
          </div>

          <div className="rounded-2xl border border-white/5 bg-white/[0.02] p-4">
            <p className="text-[11px] font-semibold text-slate-400">Active Training Runs</p>
            <p className="mt-1 text-lg font-black text-purple-300">
              {state?.telemetry.runningTrainingRuns ?? 0} <span className="text-xs font-normal text-slate-500">running ({state?.telemetry.queuedTrainingRuns ?? 0} queued)</span>
            </p>
          </div>

          <div className="rounded-2xl border border-white/5 bg-white/[0.02] p-4">
            <p className="text-[11px] font-semibold text-slate-400">Active Production Models</p>
            <p className="mt-1 text-lg font-black text-emerald-300">
              {state?.telemetry.totalActiveModels ?? 0} <span className="text-xs font-normal text-slate-500">deployed</span>
            </p>
          </div>
        </div>
      </div>

      {/* Grid of Individual Service Switchboard Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">

        {/* Card 1: Dataset Builder Worker */}
        <div className="rounded-3xl border border-white/10 bg-slate-900/60 p-6 backdrop-blur-xl shadow-xl flex flex-col justify-between space-y-5">
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Wrench className="h-5 w-5 text-cyan-400" />
                <h3 className="font-bold text-white text-base">Dataset Construction Worker</h3>
              </div>
              <span
                className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold border ${
                  datasetEnabled
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                    : 'border-slate-700 bg-slate-800 text-slate-400'
                }`}
              >
                {datasetEnabled ? 'ACTIVE' : 'STANDBY'}
              </span>
            </div>
            <p className="text-xs text-slate-400 leading-relaxed">
              Processes tick aggregation & leakage validation for multi-horizon dataset builds.
            </p>

            <div className="space-y-3 pt-2">
              <label className="flex items-center justify-between text-xs text-slate-300">
                <span>Worker Automation Status:</span>
                <input
                  type="checkbox"
                  checked={datasetEnabled}
                  onChange={(e) => setDatasetEnabled(e.target.checked)}
                  disabled={isManual}
                  className="h-4 w-4 rounded border-white/20 bg-slate-800 text-cyan-500 focus:ring-cyan-400 disabled:opacity-40 cursor-pointer"
                />
              </label>

              <div className="space-y-1">
                <div className="flex justify-between text-xs text-slate-300">
                  <span>Max Concurrent Build Jobs:</span>
                  <span className="font-bold text-cyan-300">{datasetConcurrency}</span>
                </div>
                <input
                  type="range"
                  min={1}
                  max={8}
                  value={datasetConcurrency}
                  onChange={(e) => setDatasetConcurrency(Number(e.target.value))}
                  className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-cyan-400"
                />
              </div>
            </div>
          </div>

          <button
            onClick={() =>
              void postAction({
                action: 'update_dataset_worker',
                enabled: datasetEnabled,
                maxConcurrentJobs: datasetConcurrency,
              })
            }
            disabled={saving}
            className="w-full py-2.5 rounded-xl border border-cyan-500/30 bg-cyan-500/10 text-cyan-200 text-xs font-bold hover:bg-cyan-500/20 transition cursor-pointer disabled:opacity-50"
          >
            Apply Dataset Worker Settings
          </button>
        </div>

        {/* Card 2: ML Training Queue Worker */}
        <div className="rounded-3xl border border-white/10 bg-slate-900/60 p-6 backdrop-blur-xl shadow-xl flex flex-col justify-between space-y-5">
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Cpu className="h-5 w-5 text-purple-400" />
                <h3 className="font-bold text-white text-base">ML Training Queue Worker</h3>
              </div>
              <span
                className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold border ${
                  !queuePaused
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                    : 'border-amber-500/30 bg-amber-500/10 text-amber-300'
                }`}
              >
                {!queuePaused ? 'ACTIVE' : 'PAUSED'}
              </span>
            </div>
            <p className="text-xs text-slate-400 leading-relaxed">
              Executes parallel model training pipelines (LightGBM, XGBoost, CatBoost, Neural Networks).
            </p>

            <div className="space-y-3 pt-2">
              <label className="flex items-center justify-between text-xs text-slate-300">
                <span>Pause Training Queue:</span>
                <input
                  type="checkbox"
                  checked={queuePaused}
                  onChange={(e) => setQueuePaused(e.target.checked)}
                  className="h-4 w-4 rounded border-white/20 bg-slate-800 text-purple-500 focus:ring-purple-400 cursor-pointer"
                />
              </label>

              <div className="space-y-1">
                <div className="flex justify-between text-xs text-slate-300">
                  <span>Concurrency Throttle:</span>
                  <span className="font-bold text-purple-300">{queueConcurrency} workers</span>
                </div>
                <input
                  type="range"
                  min={1}
                  max={16}
                  value={queueConcurrency}
                  onChange={(e) => setQueueConcurrency(Number(e.target.value))}
                  className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-purple-400"
                />
              </div>
            </div>
          </div>

          <button
            onClick={() =>
              void postAction({
                action: 'update_training_queue',
                isPaused: queuePaused,
                concurrencyLimit: queueConcurrency,
              })
            }
            disabled={saving}
            className="w-full py-2.5 rounded-xl border border-purple-500/30 bg-purple-500/10 text-purple-200 text-xs font-bold hover:bg-purple-500/20 transition cursor-pointer disabled:opacity-50"
          >
            Apply Training Queue Settings
          </button>
        </div>

        {/* Card 3: Auto-Retraining Automation */}
        <div className="rounded-3xl border border-white/10 bg-slate-900/60 p-6 backdrop-blur-xl shadow-xl flex flex-col justify-between space-y-5">
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Sparkles className="h-5 w-5 text-amber-400" />
                <h3 className="font-bold text-white text-base">Auto-Retraining Automation</h3>
              </div>
              <span
                className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold border ${
                  retrainingEnabled
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                    : 'border-slate-700 bg-slate-800 text-slate-400'
                }`}
              >
                {retrainingEnabled ? 'SCHEDULED' : 'DISABLED'}
              </span>
            </div>
            <p className="text-xs text-slate-400 leading-relaxed">
              Triggers periodic retraining cycles when market regime shift or model decay is detected.
            </p>

            <div className="space-y-3 pt-2">
              <label className="flex items-center justify-between text-xs text-slate-300">
                <span>Auto-Retraining Loop:</span>
                <input
                  type="checkbox"
                  checked={retrainingEnabled}
                  onChange={(e) => setRetrainingEnabled(e.target.checked)}
                  disabled={isManual}
                  className="h-4 w-4 rounded border-white/20 bg-slate-800 text-amber-500 focus:ring-amber-400 disabled:opacity-40 cursor-pointer"
                />
              </label>

              <div className="grid grid-cols-2 gap-2 text-xs">
                <div>
                  <span className="text-slate-400 block mb-1">Interval (Hours):</span>
                  <input
                    type="number"
                    min={1}
                    max={168}
                    value={retrainingInterval}
                    onChange={(e) => setRetrainingInterval(Number(e.target.value))}
                    className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-1.5 text-xs text-white"
                  />
                </div>
                <div>
                  <span className="text-slate-400 block mb-1">Min Accuracy:</span>
                  <input
                    type="number"
                    step={0.01}
                    min={0.1}
                    max={1.0}
                    value={retrainingThreshold}
                    onChange={(e) => setRetrainingThreshold(Number(e.target.value))}
                    className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-1.5 text-xs text-white"
                  />
                </div>
              </div>
            </div>
          </div>

          <button
            onClick={() =>
              void postAction({
                action: 'update_retraining_automation',
                enabled: retrainingEnabled,
                intervalHours: retrainingInterval,
                minAccuracyThreshold: retrainingThreshold,
              })
            }
            disabled={saving}
            className="w-full py-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 text-amber-200 text-xs font-bold hover:bg-amber-500/20 transition cursor-pointer disabled:opacity-50"
          >
            Apply Retraining Settings
          </button>
        </div>

        {/* Card 4: Circuit Breaker & Drift Evaluator */}
        <div className="rounded-3xl border border-white/10 bg-slate-900/60 p-6 backdrop-blur-xl shadow-xl flex flex-col justify-between space-y-5">
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ShieldAlert className="h-5 w-5 text-emerald-400" />
                <h3 className="font-bold text-white text-base">Model Circuit Breakers</h3>
              </div>
              <span
                className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold border ${
                  cbEnabled
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                    : 'border-slate-700 bg-slate-800 text-slate-400'
                }`}
              >
                {cbEnabled ? 'PROTECTING' : 'OFF'}
              </span>
            </div>
            <p className="text-xs text-slate-400 leading-relaxed">
              Monitors live inference accuracy and automatically demotes drifted champions to protect capital.
            </p>

            <div className="space-y-3 pt-2">
              <label className="flex items-center justify-between text-xs text-slate-300">
                <span>Circuit Breakers Active:</span>
                <input
                  type="checkbox"
                  checked={cbEnabled}
                  onChange={(e) => setCbEnabled(e.target.checked)}
                  className="h-4 w-4 rounded border-white/20 bg-slate-800 text-emerald-500 focus:ring-emerald-400 cursor-pointer"
                />
              </label>

              <label className="flex items-center justify-between text-xs text-slate-300">
                <span>Auto-Demote Broken Models:</span>
                <input
                  type="checkbox"
                  checked={cbAutoDemote}
                  onChange={(e) => setCbAutoDemote(e.target.checked)}
                  className="h-4 w-4 rounded border-white/20 bg-slate-800 text-emerald-500 focus:ring-emerald-400 cursor-pointer"
                />
              </label>

              <div className="space-y-1">
                <div className="flex justify-between text-xs text-slate-300">
                  <span>Drift Accuracy Tolerance:</span>
                  <span className="font-bold text-emerald-300">{(cbDriftTolerance * 100).toFixed(0)}%</span>
                </div>
                <input
                  type="range"
                  min={0.1}
                  max={0.9}
                  step={0.01}
                  value={cbDriftTolerance}
                  onChange={(e) => setCbDriftTolerance(Number(e.target.value))}
                  className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-emerald-400"
                />
              </div>
            </div>
          </div>

          <button
            onClick={() =>
              void postAction({
                action: 'update_circuit_breaker',
                enabled: cbEnabled,
                autoDemote: cbAutoDemote,
                driftToleranceRatio: cbDriftTolerance,
              })
            }
            disabled={saving}
            className="w-full py-2.5 rounded-xl border border-emerald-500/30 bg-emerald-500/10 text-emerald-200 text-xs font-bold hover:bg-emerald-500/20 transition cursor-pointer disabled:opacity-50"
          >
            Apply Circuit Breaker Settings
          </button>
        </div>

        {/* Card 5: Deriv Tick Ingestion Sync */}
        <div className="rounded-3xl border border-white/10 bg-slate-900/60 p-6 backdrop-blur-xl shadow-xl flex flex-col justify-between space-y-5">
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Radio className="h-5 w-5 text-blue-400" />
                <h3 className="font-bold text-white text-base">Deriv Tick Stream Ingestion</h3>
              </div>
              <span
                className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold border ${
                  tickEnabled
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                    : 'border-slate-700 bg-slate-800 text-slate-400'
                }`}
              >
                {tickEnabled ? 'STREAMING' : 'PAUSED'}
              </span>
            </div>
            <p className="text-xs text-slate-400 leading-relaxed">
              Real-time tick ingestion for synthetic volatility assets and live price feed caching.
            </p>

            <div className="space-y-3 pt-2">
              <label className="flex items-center justify-between text-xs text-slate-300">
                <span>Ingestion Stream Enabled:</span>
                <input
                  type="checkbox"
                  checked={tickEnabled}
                  onChange={(e) => setTickEnabled(e.target.checked)}
                  className="h-4 w-4 rounded border-white/20 bg-slate-800 text-blue-500 focus:ring-blue-400 cursor-pointer"
                />
              </label>

              <div className="space-y-1">
                <div className="flex justify-between text-xs text-slate-300">
                  <span>Max Monitored Assets:</span>
                  <span className="font-bold text-blue-300">{tickMaxSymbols} symbols</span>
                </div>
                <input
                  type="range"
                  min={1}
                  max={100}
                  value={tickMaxSymbols}
                  onChange={(e) => setTickMaxSymbols(Number(e.target.value))}
                  className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-blue-400"
                />
              </div>
            </div>
          </div>

          <button
            onClick={() =>
              void postAction({
                action: 'update_tick_ingestion',
                enabled: tickEnabled,
                maxActiveSymbols: tickMaxSymbols,
              })
            }
            disabled={saving}
            className="w-full py-2.5 rounded-xl border border-blue-500/30 bg-blue-500/10 text-blue-200 text-xs font-bold hover:bg-blue-500/20 transition cursor-pointer disabled:opacity-50"
          >
            Apply Tick Stream Settings
          </button>
        </div>

      </div>
    </div>
  );
}
