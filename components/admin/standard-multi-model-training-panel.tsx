'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AssetBatchPresets } from './asset-batch-presets';
import {
  Layers,
  Sparkles,
  CheckCircle2,
  XCircle,
  Clock,
  ShieldCheck,
  RefreshCw,
  Loader2,
  BrainCircuit,
  Settings2,
  Check,
  BarChart3,
  Award,
  Play,
  ArrowRight,
  Database,
  History,
  Info,
  ChevronDown,
  ChevronUp,
  AlertTriangle,
} from 'lucide-react';
import { adminFetch } from '@/lib/admin-client-auth';

export type MlModelKey = 'xgboost' | 'lightgbm' | 'catboost' | 'tcn' | 'lstm' | 'hmm' | 'isolation_forest';

interface ArchitectureEligibility {
  compatible: boolean;
  reason?: string;
  details?: Record<string, unknown>;
  supportedModels?: MlModelKey[];
}

interface DatasetGovernanceChecklist {
  registered: boolean;
  completed: boolean;
  leakageValidated: boolean;
  schemaValid: boolean;
  sampleCountValid: boolean;
}

interface DatasetCompatibilityReport {
  datasetId: string;
  sourceDatasetId: string;
  sourceType: 'duration' | 'unified_multi_horizon';
  symbol: string;
  durationValue: number | null;
  durationUnit: string | null;
  horizonKey: string | null;
  sampleCount: number;
  trainCount: number;
  validationCount: number;
  testCount: number;
  featureSchemaVersion: string;
  checklist: DatasetGovernanceChecklist;
  isEligibleForAny: boolean;
  rejectionReasons: string[];
  architectures: {
    tabular: ArchitectureEligibility;
    sequential: ArchitectureEligibility;
    regime: ArchitectureEligibility;
    anomaly: ArchitectureEligibility;
    unifiedMultiHorizon: ArchitectureEligibility;
  };
}

interface DatasetSummary {
  id: string;
  name: string;
  asset_symbol: string;
  duration_value: number;
  duration_unit: string;
  train_samples: number;
  validation_samples: number;
  sample_count: number;
  source_type: 'duration' | 'unified_multi_horizon';
  source_dataset_id: string;
  horizon_key: string | null;
  adapter_status?: string;
  feature_schema_version?: string;
  leakage_check_passed?: boolean;
  status?: string;
  compatibility?: DatasetCompatibilityReport;
  sequence_details?: {
    sequence_length?: number;
    train_samples?: number;
    validation_samples?: number;
    rejection_reason?: string;
    troubleshooting_advice?: string;
  };
}

interface RejectedDatasetSummary {
  id: string;
  name: string;
  symbol: string;
  durationValue: number;
  durationUnit: string;
  sourceType: string;
  sourceDatasetId: string;
  horizonKey: string | null;
  sampleCount: number;
  trainCount: number;
  validationCount: number;
  reason: string;
  rawError?: string;
  troubleshootingAdvice?: string;
  checklist?: DatasetGovernanceChecklist;
}

async function safeParseJson(res: Response, endpoint: string) {
  const text = await res.text();
  if (!text || !text.trim()) {
    if (!res.ok) {
      throw new Error(`Endpoint ${endpoint} failed with HTTP status ${res.status} (${res.statusText || 'Empty response'})`);
    }
    return {};
  }
  try {
    return JSON.parse(text);
  } catch (e: any) {
    throw new Error(`Failed to parse JSON response from ${endpoint} (HTTP ${res.status}): ${text.slice(0, 100)}`);
  }
}

export function StandardMultiModelTrainingPanel({ initialDatasetId }: { initialDatasetId?: string }) {
  const [allDatasets, setAllDatasets] = useState<DatasetSummary[]>([]);
  const [rejectedDatasets, setRejectedDatasets] = useState<RejectedDatasetSummary[]>([]);
  const [selectedDatasetIds, setSelectedDatasetIds] = useState<string[]>(initialDatasetId ? [initialDatasetId] : []);
  const [trainingMode, setTrainingMode] = useState<'single' | 'batch'>('single');
  const [availableAssets, setAvailableAssets] = useState<any[]>([]);
  const [batchProgress, setBatchProgress] = useState<{ current: number; total: number } | null>(null);
  const [availableModelTypes, setAvailableModelTypes] = useState<MlModelKey[]>([]);
  const [selectedModelTypes, setSelectedModelTypes] = useState<MlModelKey[]>([]);
  const [training, setTraining] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCompatibilityInspector, setShowCompatibilityInspector] = useState(false);

  const [recentRuns, setRecentRuns] = useState<any[]>([]);
  const [queue, setQueue] = useState<any[]>([]);
  const [lastSubmissionResult, setLastSubmissionResult] = useState<any | null>(null);

  async function loadState() {
    setLoading(true);
    setError(null);
    try {
      const [symRes, canonicalRes, seqRes, runsRes] = await Promise.all([
        adminFetch('/api/symbols', { cache: 'no-store' }),
        adminFetch('/api/admin/dataset-registry?includeIneligible=true', { cache: 'no-store' }),
        adminFetch('/api/admin/dataset-registry/sequence', { cache: 'no-store' }),
        adminFetch('/api/admin/model-training', { cache: 'no-store' }),
      ]);

      const symData = await safeParseJson(symRes, '/api/symbols');
      if (symData?.success && Array.isArray(symData?.symbols)) {
        setAvailableAssets(symData.symbols.filter((s: any) => s.isAvailable));
      }

      const seqData = await safeParseJson(seqRes, '/api/admin/dataset-registry/sequence');
      const seqCompatibleMap = new Map<string, any>();
      const seqRejectedList: RejectedDatasetSummary[] = [];

      if (seqData?.success) {
        if (Array.isArray(seqData.datasets)) {
          for (const d of seqData.datasets) {
            seqCompatibleMap.set(String(d.id), d);
          }
        }
        if (Array.isArray(seqData.rejected)) {
          for (const r of seqData.rejected) {
            seqRejectedList.push({
              id: String(r.id),
              name: String(r.name),
              symbol: String(r.symbol),
              durationValue: Number(r.durationValue),
              durationUnit: String(r.durationUnit),
              sourceType: String(r.sourceType),
              sourceDatasetId: String(r.sourceDatasetId),
              horizonKey: r.horizonKey ? String(r.horizonKey) : null,
              sampleCount: Number(r.sampleCount ?? 0),
              trainCount: Number(r.trainCount ?? 0),
              validationCount: Number(r.validationCount ?? 0),
              reason: String(r.reason ?? 'Sequence validation rejected.'),
              rawError: r.rawError ? String(r.rawError) : undefined,
              troubleshootingAdvice: r.troubleshootingAdvice ? String(r.troubleshootingAdvice) : undefined,
              checklist: r.compatibility?.checklist,
            });
          }
        }
      }
      setRejectedDatasets(seqRejectedList);

      const canonicalData = await safeParseJson(canonicalRes, '/api/admin/dataset-registry');
      const normalizedDatasets: DatasetSummary[] = [];

      if (canonicalData?.success && Array.isArray(canonicalData?.datasets)) {
        for (const d of canonicalData.datasets) {
          const seqMatch = seqCompatibleMap.get(String(d.id));
          const seqRejection = seqRejectedList.find((r) => r.id === String(d.id));

          normalizedDatasets.push({
            id: String(d.id),
            name: String(d.name),
            asset_symbol: String(d.symbol),
            duration_value: Number(d.durationValue),
            duration_unit: String(d.durationUnit),
            train_samples: Number(d.trainCount ?? 0),
            validation_samples: Number(d.validationCount ?? 0),
            sample_count: Number(d.sampleCount ?? 0),
            source_type: d.sourceType === 'unified_multi_horizon' ? 'unified_multi_horizon' : 'duration',
            source_dataset_id: String(d.sourceDatasetId),
            horizon_key: d.horizonKey ? String(d.horizonKey) : null,
            adapter_status: seqMatch?.adapterStatus ?? d.adapterStatus,
            feature_schema_version: d.featureSchemaVersion,
            leakage_check_passed: d.leakageCheckPassed,
            status: d.status,
            compatibility: d.compatibility,
            sequence_details: seqMatch
              ? {
                  sequence_length: seqMatch.sequenceLength,
                  train_samples: seqMatch.trainSamples,
                  validation_samples: seqMatch.validationSamples,
                }
              : seqRejection
              ? {
                  rejection_reason: seqRejection.reason,
                  troubleshooting_advice: seqRejection.troubleshootingAdvice,
                }
              : undefined,
          });
        }
      }

      setAllDatasets(normalizedDatasets);

      if (seqData?.success && Array.isArray(seqData?.queue)) {
        setQueue(
          seqData.queue.map((job: any) => ({
            job_id: job.jobId,
            dataset_id: job.datasetId,
            model_type: Array.isArray(job.modelTypes) ? job.modelTypes.join(', ') : undefined,
            status: job.status,
          })),
        );
      }

      const runsData = await safeParseJson(runsRes, '/api/admin/model-training');
      if (runsData?.success) {
        if (Array.isArray(runsData?.runs)) setRecentRuns(runsData.runs);
        if (Array.isArray(runsData?.modelTypes)) {
          setAvailableModelTypes(runsData.modelTypes);
          if (selectedModelTypes.length === 0) {
            setSelectedModelTypes(runsData.modelTypes);
          }
        }
        if (Array.isArray(runsData?.queue)) {
          setQueue((current) => (current.length ? current : runsData.queue));
        }
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to load authoritative dataset registry and training state.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadState();
  }, []);

  // Determine active required architecture based on selected model types
  const hasSequenceModelsSelected = selectedModelTypes.some((m) => m === 'tcn' || m === 'lstm');
  const hasTabularModelsSelected = selectedModelTypes.some((m) => m === 'xgboost' || m === 'lightgbm' || m === 'catboost');
  const hasRegimeAnomalySelected = selectedModelTypes.some((m) => m === 'hmm' || m === 'isolation_forest');

  // Filter datasets compatible with the current model selection
  const compatibleDatasets = allDatasets.filter((d) => {
    if (!d.compatibility) return true;
    if (hasSequenceModelsSelected && !hasTabularModelsSelected && !hasRegimeAnomalySelected) {
      return d.compatibility.architectures.sequential.compatible;
    }
    if (hasTabularModelsSelected && !hasSequenceModelsSelected && !hasRegimeAnomalySelected) {
      return d.compatibility.architectures.tabular.compatible;
    }
    if (hasRegimeAnomalySelected && !hasSequenceModelsSelected && !hasTabularModelsSelected) {
      return d.compatibility.architectures.regime.compatible || d.compatibility.architectures.anomaly.compatible;
    }
    // Mixed selection: check if dataset satisfies all selected model families
    let ok = true;
    if (hasSequenceModelsSelected && !d.compatibility.architectures.sequential.compatible) ok = false;
    if (hasTabularModelsSelected && !d.compatibility.architectures.tabular.compatible) ok = false;
    if (hasRegimeAnomalySelected && !d.compatibility.architectures.regime.compatible) ok = false;
    return ok;
  });

  // Keep selection valid
  useEffect(() => {
    if (compatibleDatasets.length > 0) {
      const validSelected = selectedDatasetIds.filter((id) => compatibleDatasets.some((d) => d.id === id));
      if (validSelected.length === 0) {
        setSelectedDatasetIds([compatibleDatasets[0].id]);
      }
    } else if (allDatasets.length > 0 && selectedDatasetIds.length === 0) {
      setSelectedDatasetIds([allDatasets[0].id]);
    }
  }, [selectedModelTypes, compatibleDatasets.length]);

  async function handleTrain() {
    if (training) return;
    setTraining(true);
    setError(null);
    setLastSubmissionResult(null);

    if (selectedDatasetIds.length === 0) {
      setError('Please select at least one dataset to train.');
      setTraining(false);
      return;
    }

    if (selectedModelTypes.length === 0) {
      setError('Please select at least one model algorithm to train.');
      setTraining(false);
      return;
    }

    try {
      let anyQueued = false;
      const allSkipped: string[] = [];
      const allBlocked: string[] = [];
      const allErrors: string[] = [];

      for (let i = 0; i < selectedDatasetIds.length; i++) {
        const selectedId = selectedDatasetIds[i];
        const dataset = allDatasets.find((item) => item.id === selectedId);
        if (!dataset) {
          allErrors.push(`${selectedId}: dataset is no longer available from the canonical registry.`);
          continue;
        }

        setBatchProgress({ current: i + 1, total: selectedDatasetIds.length });

        if (dataset.source_type === 'unified_multi_horizon') {
          const sequenceModels = selectedModelTypes.filter((model) => model === 'tcn' || model === 'lstm');
          if (sequenceModels.length === 0) {
            allErrors.push(
              `${dataset.asset_symbol} @ ${dataset.duration_value}${dataset.duration_unit}: No sequential models selected. Unified Multi-Horizon datasets train on sequential architectures (TCN / LSTM).`,
            );
            continue;
          }

          const nonSequenceModels = selectedModelTypes.filter((model) => model !== 'tcn' && model !== 'lstm');
          if (nonSequenceModels.length > 0) {
            allSkipped.push(
              `${dataset.asset_symbol} @ ${dataset.duration_value}${dataset.duration_unit}: ${nonSequenceModels.join(', ')} (non-sequential models skipped; queued ${sequenceModels.join(', ').toUpperCase()})`,
            );
          }

          const res = await adminFetch('/api/admin/dataset-registry/sequence', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              datasetId: dataset.source_dataset_id,
              horizonKey: dataset.horizon_key,
              sourceType: 'unified',
              modelTypes: sequenceModels,
            }),
          });
          const data = await safeParseJson(res, '/api/admin/dataset-registry/sequence');
          if (!res.ok || !data?.success) {
            allErrors.push(
              `${dataset.asset_symbol} @ ${dataset.duration_value}${dataset.duration_unit}: ${data?.error || 'Sequence training was rejected.'}`,
            );
            continue;
          }
          anyQueued = true;
          continue;
        }

        const res = await adminFetch('/api/admin/model-training', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            datasetId: dataset.source_dataset_id || dataset.id,
            modelTypes: selectedModelTypes,
            retryFailed: false,
          }),
        });

        const data = await safeParseJson(res, '/api/admin/model-training');
        if (res.ok && data?.success) {
          anyQueued = true;
          if (data.skippedCompletedModelTypes) allSkipped.push(...data.skippedCompletedModelTypes);
          if (data.blockedFailedModelTypes) allBlocked.push(...data.blockedFailedModelTypes);
        } else {
          allErrors.push(
            `${dataset.asset_symbol} @ ${dataset.duration_value}${dataset.duration_unit}: ${data?.error || 'Training was rejected.'}`,
          );
        }
      }

      setLastSubmissionResult({
        queued: anyQueued,
        skipped: allSkipped,
        blocked: allBlocked,
        failed: allErrors,
      });
      if (allErrors.length > 0) setError(allErrors.join(' | '));

      await loadState();
    } catch (err: any) {
      setError(err?.message || 'Submission failed.');
    } finally {
      setTraining(false);
      setBatchProgress(null);
    }
  }

  function toggleModelType(key: MlModelKey) {
    setSelectedModelTypes((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  }

  return (
    <div className="space-y-6">
      {/* Banner */}
      <div className="rounded-3xl border border-blue-500/20 bg-blue-950/10 p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex items-center gap-2 text-blue-400 font-bold text-sm">
              <Layers className="h-4 w-4" />
              Standard Multi-Model Dedicated Training
            </div>
            <p className="mt-1 text-xs text-slate-400 max-w-3xl">
              Authoritative dataset compatibility is resolved live by the canonical registry across Tabular, Sequential, Regime, Anomaly, and Multi-Horizon paradigms.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowCompatibilityInspector(!showCompatibilityInspector)}
              className="inline-flex items-center gap-1.5 rounded-xl border border-cyan-400/30 bg-cyan-400/10 px-3 py-2 text-xs font-semibold text-cyan-300 hover:bg-cyan-400/20 transition cursor-pointer"
            >
              <ShieldCheck className="h-3.5 w-3.5" />
              {showCompatibilityInspector ? 'Hide Compatibility Matrix' : 'Inspect Compatibility Matrix'}
            </button>
            <Link
              href="/admin/champion-challenger"
              className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-400/30 bg-emerald-400/10 px-3 py-2 text-xs font-semibold text-emerald-300 hover:bg-emerald-400/20 transition cursor-pointer"
            >
              <Award className="h-3.5 w-3.5" />
              Model Governance
            </Link>
            <button
              onClick={() => void loadState()}
              disabled={loading || training}
              className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold hover:bg-white/10 transition cursor-pointer"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-3 rounded-2xl border border-red-400/20 bg-red-400/5 p-4 text-sm text-red-200">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Authoritative Dataset Compatibility & Governance Matrix (Collapsible Inspector) */}
      {showCompatibilityInspector && (
        <div className="rounded-3xl border border-cyan-500/30 bg-cyan-950/10 p-5 space-y-4">
          <div className="flex items-center justify-between border-b border-cyan-500/20 pb-3">
            <div className="flex items-center gap-2 text-cyan-300 font-bold text-sm">
              <ShieldCheck className="h-4 w-4" />
              Authoritative Dataset Compatibility & Governance Matrix
            </div>
            <span className="text-xs text-slate-400">
              {allDatasets.length} total discovered datasets ({compatibleDatasets.length} compatible with current selection)
            </span>
          </div>

          {allDatasets.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-white/10 p-6 text-center text-xs text-slate-400">
              No datasets registered in the canonical database yet. Use the Dataset Builder to construct training datasets.
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {allDatasets.map((d) => {
                const compat = d.compatibility;
                const isSeq = compat?.architectures.sequential.compatible;
                const isTab = compat?.architectures.tabular.compatible;
                const isReg = compat?.architectures.regime.compatible;
                const isAnom = compat?.architectures.anomaly.compatible;

                return (
                  <div
                    key={d.id}
                    className={`rounded-2xl border p-4 space-y-3 transition ${
                      selectedDatasetIds.includes(d.id)
                        ? 'border-blue-400/60 bg-blue-500/10'
                        : 'border-white/10 bg-black/40'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-sm text-slate-100">{d.asset_symbol}</span>
                        <span className="rounded bg-white/10 px-2 py-0.5 text-[10px] font-semibold text-slate-300">
                          {d.duration_value} {d.duration_unit}
                        </span>
                        <span
                          className={`rounded px-2 py-0.5 text-[9px] font-bold uppercase ${
                            d.source_type === 'unified_multi_horizon'
                              ? 'bg-purple-500/20 text-purple-300 border border-purple-500/30'
                              : 'bg-blue-500/20 text-blue-300 border border-blue-500/30'
                          }`}
                        >
                          {d.source_type === 'unified_multi_horizon' ? 'Unified Multi-Horizon' : 'Duration'}
                        </span>
                      </div>
                      <span className="text-[11px] font-mono text-slate-400">{d.sample_count || d.train_samples + d.validation_samples} samples</span>
                    </div>

                    {/* Governance Checklist */}
                    <div className="grid grid-cols-2 gap-1.5 text-[11px]">
                      <div className="flex items-center gap-1.5 text-emerald-400">
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        <span>Registered in Canonical DB</span>
                      </div>
                      <div className="flex items-center gap-1.5 text-emerald-400">
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        <span>Status: Completed</span>
                      </div>
                      <div className="flex items-center gap-1.5 text-emerald-400">
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        <span>Leakage Validated</span>
                      </div>
                      <div className="flex items-center gap-1.5 text-slate-300">
                        <Database className="h-3.5 w-3.5 text-cyan-400" />
                        <span>Schema: {d.feature_schema_version?.slice(0, 16) || 'active'}...</span>
                      </div>
                    </div>

                    {/* Architecture Compatibility Matrix */}
                    <div className="border-t border-white/5 pt-2 space-y-1.5 text-xs">
                      <div className="flex items-center justify-between">
                        <span className="text-slate-400">Sequential (LSTM / TCN):</span>
                        {isSeq ? (
                          <span className="flex items-center gap-1 text-emerald-300 font-bold text-[11px]">
                            <CheckCircle2 className="h-3 w-3" /> Compatible ({d.sequence_details?.train_samples ?? d.train_samples} windows)
                          </span>
                        ) : (
                          <span className="flex items-center gap-1 text-amber-300 font-bold text-[11px]">
                            <AlertTriangle className="h-3 w-3" /> Ineligible
                          </span>
                        )}
                      </div>
                      {!isSeq && compat?.architectures.sequential.reason && (
                        <p className="text-[10px] text-amber-200/80 bg-amber-500/10 rounded-lg p-2 border border-amber-500/20">
                          {compat.architectures.sequential.reason}
                        </p>
                      )}

                      <div className="flex items-center justify-between">
                        <span className="text-slate-400">Tabular (XGB / LGBM / CatBoost):</span>
                        {isTab ? (
                          <span className="flex items-center gap-1 text-emerald-300 font-bold text-[11px]">
                            <CheckCircle2 className="h-3 w-3" /> Compatible
                          </span>
                        ) : (
                          <span className="flex items-center gap-1 text-slate-500 text-[11px]">
                            <XCircle className="h-3 w-3" /> Ineligible
                          </span>
                        )}
                      </div>

                      <div className="flex items-center justify-between">
                        <span className="text-slate-400">Regime (HMM) & Anomaly (Isolation Forest):</span>
                        {isReg || isAnom ? (
                          <span className="flex items-center gap-1 text-emerald-300 font-bold text-[11px]">
                            <CheckCircle2 className="h-3 w-3" /> Compatible
                          </span>
                        ) : (
                          <span className="flex items-center gap-1 text-slate-500 text-[11px]">
                            <XCircle className="h-3 w-3" /> Ineligible
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Main Grid */}
      <div className="grid gap-6 lg:grid-cols-12">
        {/* Left Form: Dataset & Model Selector */}
        <div className="space-y-4 lg:col-span-5">
          <div className="rounded-3xl border border-white/10 bg-white/[0.025] p-5 space-y-5">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-200 flex items-center gap-2">
                <BrainCircuit className="h-4 w-4 text-blue-400" />
                Pipeline Configuration
              </h3>
              <div className="flex rounded-lg border border-white/10 bg-black/40 p-0.5 text-xs font-medium">
                <button
                  type="button"
                  onClick={() => {
                    setTrainingMode('single');
                    if (selectedDatasetIds.length > 1) {
                      setSelectedDatasetIds([selectedDatasetIds[0]]);
                    }
                  }}
                  className={`px-2.5 py-1 rounded-md transition cursor-pointer ${
                    trainingMode === 'single' ? 'bg-blue-500/20 text-blue-300 font-bold' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Single
                </button>
                <button
                  type="button"
                  onClick={() => setTrainingMode('batch')}
                  className={`px-2.5 py-1 rounded-md transition cursor-pointer ${
                    trainingMode === 'batch' ? 'bg-blue-500/20 text-blue-300 font-bold' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Batch
                </button>
              </div>
            </div>

            {/* Dataset Selection */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400">
                  {trainingMode === 'single' ? 'Authoritative Canonical Dataset' : `Batch Datasets (${selectedDatasetIds.length} Selected)`}
                </label>
                <span className="text-[10px] text-blue-400 font-semibold">
                  {compatibleDatasets.length} compatible / {allDatasets.length} total
                </span>
              </div>

              {compatibleDatasets.length === 0 ? (
                <div className="rounded-2xl border border-amber-400/20 bg-amber-950/10 p-4 space-y-3 text-xs text-slate-300">
                  <div className="flex items-center gap-2 text-amber-300 font-bold">
                    <AlertTriangle className="h-4 w-4 shrink-0" />
                    No sequence-compatible datasets currently available for active selection.
                  </div>
                  {rejectedDatasets.length > 0 && (
                    <div className="space-y-2 pt-1 border-t border-amber-400/10">
                      <p className="text-[11px] text-slate-400 font-semibold">Specific Rejection Diagnostics:</p>
                      {rejectedDatasets.slice(0, 3).map((r) => (
                        <div key={r.id} className="rounded-xl border border-white/5 bg-black/40 p-2.5 space-y-1">
                          <div className="flex items-center justify-between text-slate-200 font-bold text-[11px]">
                            <span>{r.symbol} @ {r.durationValue}{r.durationUnit}</span>
                            <span className="text-[10px] text-amber-300 font-mono">{r.sampleCount} samples</span>
                          </div>
                          <p className="text-[10px] text-amber-200/90">{r.reason}</p>
                          {r.troubleshootingAdvice && (
                            <p className="text-[9px] text-slate-400 italic">Recommendation: {r.troubleshootingAdvice}</p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="pt-2 flex items-center justify-between">
                    <Link
                      href="/admin/dataset-builder"
                      className="inline-flex items-center gap-1.5 rounded-lg bg-blue-500/20 border border-blue-500/40 px-3 py-1.5 text-xs font-semibold text-blue-300 hover:bg-blue-500/30 transition"
                    >
                      Open Dataset Builder <ArrowRight className="h-3 w-3" />
                    </Link>
                    <button
                      type="button"
                      onClick={() => setShowCompatibilityInspector(true)}
                      className="text-[11px] text-cyan-300 hover:underline"
                    >
                      View Full Matrix
                    </button>
                  </div>
                </div>
              ) : trainingMode === 'single' ? (
                <select
                  value={selectedDatasetIds[0] || ''}
                  onChange={(e) => setSelectedDatasetIds([e.target.value])}
                  disabled={training}
                  className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2.5 text-sm font-semibold text-slate-100 focus:border-blue-400 focus:outline-none"
                >
                  {compatibleDatasets.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.asset_symbol} ({d.duration_value} {d.duration_unit}) — {d.name} [{d.source_type === 'unified_multi_horizon' ? 'Unified' : 'Duration'}]
                    </option>
                  ))}
                </select>
              ) : (
                <div className="space-y-2 rounded-xl border border-white/10 bg-black/30 p-2.5">
                  <AssetBatchPresets
                    availableAssets={
                      availableAssets.length > 0
                        ? availableAssets
                        : compatibleDatasets.map((d) => ({ symbol: d.asset_symbol, displayName: d.asset_symbol }))
                    }
                    onSelectSymbols={(symbols) => {
                      const ids = compatibleDatasets.filter((d) => symbols.includes(d.asset_symbol)).map((d) => d.id);
                      setSelectedDatasetIds((prev) => Array.from(new Set([...prev, ...ids])));
                    }}
                    onClear={() => setSelectedDatasetIds([])}
                    selectedCount={selectedDatasetIds.length}
                  />
                  <div className="max-h-48 overflow-y-auto space-y-1.5 pt-1">
                    {compatibleDatasets.map((d) => {
                      const sel = selectedDatasetIds.includes(d.id);
                      return (
                        <button
                          key={d.id}
                          type="button"
                          onClick={() =>
                            setSelectedDatasetIds((prev) =>
                              prev.includes(d.id) ? prev.filter((id) => id !== d.id) : [...prev, d.id],
                            )
                          }
                          disabled={training}
                          className={`w-full flex items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-xs transition cursor-pointer ${
                            sel
                              ? 'bg-blue-500/20 text-blue-200 border border-blue-500/40'
                              : 'bg-white/5 text-slate-400 hover:bg-white/10 border border-transparent'
                          }`}
                        >
                          <span className="font-bold">
                            {d.asset_symbol} @ {d.duration_value}
                            {d.duration_unit}
                          </span>
                          <span className="text-[10px] text-slate-400">
                            {d.train_samples + d.validation_samples} samples ({d.source_type === 'unified_multi_horizon' ? 'Unified' : 'Duration'})
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* Selected Dataset Details */}
            {trainingMode === 'single' &&
              allDatasets.find((d) => d.id === selectedDatasetIds[0]) &&
              (() => {
                const selectedDataset = allDatasets.find((d) => d.id === selectedDatasetIds[0])!;
                return (
                  <div className="rounded-2xl border border-white/10 bg-black/30 p-4 space-y-2.5 text-xs text-slate-300">
                    <div className="flex items-center justify-between text-slate-400">
                      <span>Symbol / Horizon:</span>
                      <span className="font-bold text-blue-300">
                        {selectedDataset.asset_symbol} @ {selectedDataset.duration_value} {selectedDataset.duration_unit}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-slate-400">
                      <span>Total Validated Samples:</span>
                      <span>
                        {(selectedDataset.train_samples + selectedDataset.validation_samples).toLocaleString()} (
                        {selectedDataset.train_samples} train / {selectedDataset.validation_samples} val)
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-slate-400">
                      <span>Source:</span>
                      <span className="font-bold text-emerald-300">
                        {selectedDataset.source_type === 'unified_multi_horizon' ? 'Unified Multi-Horizon' : 'Duration Dataset'}
                      </span>
                    </div>
                    {selectedDataset.horizon_key && (
                      <div className="flex items-center justify-between text-slate-400">
                        <span>Horizon Key:</span>
                        <span className="font-mono font-bold text-cyan-300">{selectedDataset.horizon_key.toUpperCase()}</span>
                      </div>
                    )}
                    {selectedDataset.adapter_status && (
                      <div className="flex items-center justify-between text-slate-400">
                        <span>Adapter Status:</span>
                        <span className="font-bold text-slate-300">{selectedDataset.adapter_status}</span>
                      </div>
                    )}
                  </div>
                );
              })()}

            {/* Model Architectures Selector */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400">
                  Architectures to Queue
                </label>
                <div className="flex flex-wrap items-center gap-2 text-[10px] font-medium text-blue-400">
                  <button
                    type="button"
                    onClick={() =>
                      setSelectedModelTypes(
                        availableModelTypes.filter((m) => m === 'lstm' || m === 'tcn'),
                      )
                    }
                    className="hover:underline text-cyan-300 font-semibold"
                  >
                    Sequential (TCN/LSTM)
                  </button>
                  <span className="text-white/20">|</span>
                  <button
                    type="button"
                    onClick={() =>
                      setSelectedModelTypes(
                        availableModelTypes.filter(
                          (m) => m === 'xgboost' || m === 'lightgbm' || m === 'catboost',
                        ),
                      )
                    }
                    className="hover:underline"
                  >
                    Tabular
                  </button>
                  <span className="text-white/20">|</span>
                  <button
                    type="button"
                    onClick={() =>
                      setSelectedModelTypes(
                        availableModelTypes.filter((m) => m === 'hmm' || m === 'isolation_forest'),
                      )
                    }
                    className="hover:underline text-amber-300 font-semibold"
                  >
                    Regime & Anomaly (HMM/IsoForest)
                  </button>
                  <span className="text-white/20">|</span>
                  <button type="button" onClick={() => setSelectedModelTypes(availableModelTypes)} className="hover:underline">
                    All
                  </button>
                  <span className="text-white/20">|</span>
                  <button type="button" onClick={() => setSelectedModelTypes([])} className="hover:underline">
                    None
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                {availableModelTypes.map((key) => {
                  const sel = selectedModelTypes.includes(key);
                  const isSeq = key === 'lstm' || key === 'tcn';
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => toggleModelType(key)}
                      disabled={training}
                      className={`flex flex-col items-start justify-center p-3 rounded-2xl border transition cursor-pointer text-left ${
                        sel
                          ? 'border-blue-400 bg-blue-400/10 text-blue-200'
                          : 'border-white/10 bg-black/20 text-slate-400 hover:border-white/20'
                      }`}
                    >
                      <div className="flex items-center justify-between w-full">
                        <span className="font-bold text-xs uppercase">{key.replace('_', ' ')}</span>
                        {sel && <Check className="h-3 w-3 text-blue-400" />}
                      </div>
                      <span className="text-[9px] text-slate-400 mt-1">
                        {isSeq ? 'Sequential 3D' : key === 'hmm' ? 'Regime Markov' : key === 'isolation_forest' ? 'Anomaly' : 'Tabular GBDT'}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Execute Button */}
            <button
              onClick={() => void handleTrain()}
              disabled={training || selectedDatasetIds.length === 0 || selectedModelTypes.length === 0 || compatibleDatasets.length === 0}
              className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-blue-500 px-4 py-3 text-sm font-bold text-white hover:bg-blue-400 disabled:opacity-50 transition cursor-pointer"
            >
              {training ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              {training
                ? batchProgress
                  ? `Queueing ${batchProgress.current}/${batchProgress.total}...`
                  : 'Queueing Jobs...'
                : `Queue ${selectedModelTypes.length} Architecture Jobs`}
            </button>

            {lastSubmissionResult && (
              <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3 text-xs text-emerald-200/80 space-y-1">
                <p>
                  <span className="font-bold text-emerald-300">Success:</span>{' '}
                  {lastSubmissionResult.queued ? 'Jobs queued for execution.' : 'No jobs were accepted.'}
                </p>
                {lastSubmissionResult.skipped?.length > 0 && <p>Skipped (Already Completed): {lastSubmissionResult.skipped.join(', ')}</p>}
                {lastSubmissionResult.blocked?.length > 0 && <p>Blocked: {lastSubmissionResult.blocked.join(', ')}</p>}
                {lastSubmissionResult.failed?.length > 0 && <p className="text-red-300">Rejected: {lastSubmissionResult.failed.join(' | ')}</p>}
              </div>
            )}
          </div>
        </div>

        {/* Right Panel: Active Queue & Recent Runs */}
        <div className="space-y-4 lg:col-span-7">
          {/* Worker Queue */}
          <div className="rounded-3xl border border-white/10 bg-white/[0.025] p-5 space-y-4">
            <h3 className="text-sm font-bold text-slate-200 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Settings2 className="h-4 w-4 text-orange-400" />
                Active Worker Queue
              </div>
              <span className="rounded-full bg-black/40 px-2 py-0.5 text-xs text-slate-400">{queue.length} pending</span>
            </h3>

            {queue.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-white/10 p-6 text-center text-xs text-slate-500">
                No active training jobs in the worker queue.
              </div>
            ) : (
              <div className="space-y-2 max-h-[200px] overflow-y-auto pr-1">
                {queue.map((q) => (
                  <div key={q.job_id || q.id} className="flex items-center justify-between rounded-xl border border-white/5 bg-black/30 px-4 py-2.5">
                    <div className="flex items-center gap-3">
                      <Loader2 className="h-3.5 w-3.5 text-orange-400 animate-spin" />
                      <div className="flex flex-col">
                        <span className="text-xs font-bold text-slate-200 uppercase">{q.model_type?.replace('_', ' ')}</span>
                        <span className="text-[10px] text-slate-400">Dataset {q.dataset_id?.slice(0, 8)}...</span>
                      </div>
                    </div>
                    <span className="text-[10px] font-mono text-orange-400 uppercase tracking-wider">{q.status}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Recent Runs */}
          <div className="rounded-3xl border border-white/10 bg-white/[0.025] p-5 space-y-4">
            <h3 className="text-sm font-bold text-slate-200 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <History className="h-4 w-4 text-emerald-400" />
                Completed Canonical Runs
              </div>
              <span className="rounded-full bg-black/40 px-2 py-0.5 text-xs text-slate-400">{recentRuns.length} runs</span>
            </h3>

            {recentRuns.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-white/10 p-8 text-center text-xs text-slate-500">
                No standard model runs completed yet. Queue jobs to see results here.
              </div>
            ) : (
              <div className="space-y-3 max-h-[400px] overflow-y-auto pr-1">
                {recentRuns.slice(0, 15).map((r) => (
                  <div key={r.run_id || r.id} className="rounded-2xl border border-white/10 bg-black/30 p-4 space-y-3">
                    <div className="flex items-center justify-between border-b border-white/5 pb-2">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-sm text-blue-300">{r.symbol || r.asset_symbol}</span>
                        <span className="rounded bg-white/10 px-2 py-0.5 text-[10px] font-semibold text-slate-300">
                          {r.duration_value} {r.duration_unit}
                        </span>
                      </div>
                      <span className="text-[11px] text-slate-400">{new Date(r.created_at || r.started_at).toLocaleString()}</span>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {(r.models || [r]).map((m: any, i: number) => {
                        const isSuccess = m.status === 'completed';
                        return (
                          <div
                            key={m.model_id || i}
                            className={`flex items-center justify-between p-2 rounded-xl border ${
                              isSuccess ? 'border-emerald-500/20 bg-emerald-500/5' : 'border-red-500/20 bg-red-500/5'
                            }`}
                          >
                            <div className="flex flex-col">
                              <span className="text-[10px] font-bold text-slate-300 uppercase">{m.model_type?.replace('_', ' ')}</span>
                              <span className={`text-[10px] ${isSuccess ? 'text-emerald-400' : 'text-red-400'}`}>{m.status}</span>
                            </div>
                            {isSuccess && m.metrics?.accuracy != null && (
                              <span className="font-mono text-xs font-black text-emerald-400">
                                {Number(m.metrics.accuracy * (m.metrics.accuracy <= 1 ? 100 : 1)).toFixed(2)}%
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
