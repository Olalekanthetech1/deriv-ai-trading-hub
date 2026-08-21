export type RoadmapStatus = 'complete' | 'next' | 'planned';

export type RoadmapDomainId = 'observe-respond' | 'ml-model-ops' | 'market-strategy' | 'production-governance';

export type RoadmapSection = {
  id: string;
  title: string;
  description: string;
  status: RoadmapStatus;
  domainId: RoadmapDomainId;
};

export type RoadmapDomain = {
  id: RoadmapDomainId;
  title: string;
  description: string;
};

export const adminDomains: RoadmapDomain[] = [
  {
    id: 'observe-respond',
    title: 'Observe & Respond',
    description: 'Investigate runtime health, telemetry and active incidents.',
  },
  {
    id: 'ml-model-ops',
    title: 'ML & Model Operations',
    description: 'Manage the model lifecycle without mixing training and production inference.',
  },
  {
    id: 'market-strategy',
    title: 'Market & Strategy',
    description: 'Inspect the data and strategy layers feeding signal generation.',
  },
  {
    id: 'production-governance',
    title: 'Production & Governance',
    description: 'Verify production state and protect operational infrastructure.',
  },
];

export const adminRoadmap: RoadmapSection[] = [
  // Observe & Respond
  { id: 'command-center', domainId: 'observe-respond', title: 'Command Center', description: 'Live operational readiness and service health.', status: 'complete' },
  { id: 'operational-intelligence', domainId: 'observe-respond', title: 'Operational Intelligence', description: 'Correlate health, telemetry, ML state and production risk.', status: 'complete' },
  { id: 'observability', domainId: 'observe-respond', title: 'Observability', description: 'Persisted telemetry, correlation IDs and event stream.', status: 'complete' },
  { id: 'ai-trader-dynamics', domainId: 'observe-respond', title: 'AI Trader Dynamics', description: 'Algorithmic staking observability, active sequences, real-time drawdowns, and Circuit Breaker controls.', status: 'complete' },
  { id: 'incident-center', domainId: 'observe-respond', title: 'Incident Center', description: 'Operational incidents, severity triage, dependency health and response workflow.', status: 'next' },
  { id: 'signal-forensics', domainId: 'observe-respond', title: 'Signal Forensics', description: 'Trace signal decisions and supporting evidence.', status: 'next' },

  // ML & Model Operations
  { id: 'tradeability', domainId: 'ml-model-ops', title: 'Asset Tradeability Matrix', description: 'Real-time ensemble completeness verification (Directional, HMM Regime, Isolation Forest) across all asset durations.', status: 'complete' },
  { id: 'model-deployment', domainId: 'ml-model-ops', title: 'Model Deployment & Activation', description: 'Direct one-click live production activation and asset fleet coverage for all trained models.', status: 'complete' },
  { id: 'models', domainId: 'ml-model-ops', title: 'Model Operations', description: 'Registry, model metadata, promotion, rollback and retraining lifecycle.', status: 'complete' },
  { id: 'ml-config', domainId: 'ml-model-ops', title: 'ML Pipeline Configuration', description: 'Controlled configuration for the ML pipeline from canonical registries.', status: 'next' },
  { id: 'training-pipeline', domainId: 'ml-model-ops', title: 'Training Pipeline', description: 'Training jobs, datasets and execution state.', status: 'complete' },
  { id: 'horizon-audit', domainId: 'ml-model-ops', title: 'Horizon Execution Audit', description: 'Real-time telemetry audit comparing target HDE horizons vs actual Deriv execution durations.', status: 'complete' },
  { id: 'retraining', domainId: 'ml-model-ops', title: 'Retraining & Automation', description: 'Drift-triggered automated retraining and zero-downtime model promotion.', status: 'complete' },
  { id: 'champion-challenger', domainId: 'ml-model-ops', title: 'Champion / Challenger', description: 'Compare candidate models before production promotion.', status: 'next' },
  { id: 'prediction-integration', domainId: 'ml-model-ops', title: 'Prediction Integration', description: 'Production prediction-path verification and model lineage.', status: 'next' },
  { id: 'model-artifacts', domainId: 'ml-model-ops', title: 'Artifact Integrity & Migration', description: 'Durable production artifact health, lineage verification and controlled migration.', status: 'next' },
  { id: 'model-cleanup', domainId: 'ml-model-ops', title: 'Model Cleanup', description: 'Safely remove obsolete candidate and staging registry records before a clean training cycle.', status: 'complete' },

  // Market & Strategy
  { id: 'market-data-ingestion', domainId: 'market-strategy', title: 'Market Data Ingestion', description: 'Provider connectivity, freshness, historical ticks and ingestion state.', status: 'complete' },
  { id: 'asset-strategy', domainId: 'market-strategy', title: 'Asset-Aware Strategy', description: 'Asset-specific strategy, market-type selection and regime controls.', status: 'next' },
  { id: 'dataset-builder', domainId: 'market-strategy', title: 'Training Dataset Builder', description: 'Build and inspect model training datasets with leakage validation.', status: 'complete' },
  { id: 'experiments', domainId: 'market-strategy', title: 'Testing & Research', description: 'Experiments, evaluations and persistent research evidence.', status: 'complete' },
  { id: 'intelligence', domainId: 'market-strategy', title: 'Trading Intelligence', description: 'Signals, confidence, strategy outcomes, features, horizons and model intelligence.', status: 'complete' },

  // Production & Governance
  { id: 'final-verification', domainId: 'production-governance', title: 'Production Verification', description: 'Evidence-based production readiness checks.', status: 'next' },
  { id: 'security', domainId: 'production-governance', title: 'Security & Configuration', description: 'Security posture, secrets exposure, session controls and security events.', status: 'complete' },
  { id: 'database', domainId: 'production-governance', title: 'Database Operations', description: 'Database diagnostics, schema migration, data integrity and operational maintenance.', status: 'complete' },
  { id: 'infrastructure', domainId: 'production-governance', title: 'Runtime & Infrastructure', description: 'Latency, APIs, WebSockets, database, cron and runtime diagnostics.', status: 'complete' },
  { id: 'telegram-branding', domainId: 'production-governance', title: 'Telegram Bot Branding', description: 'Configure dynamic branding banner image URLs for Telegram bot screens.', status: 'complete' },
  { id: 'worker-control', domainId: 'production-governance', title: 'Automation & Worker Control', description: 'Central operational switchboard for background workers, queue scaling, and emergency halts.', status: 'complete' },
];

export function countRoadmapStatus(status: RoadmapStatus) {
  return adminRoadmap.filter((section) => section.status === status).length;
}
