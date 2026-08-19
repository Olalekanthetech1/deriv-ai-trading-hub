import fs from 'node:fs';

const page = fs.readFileSync('app/admin/signal-forensics/page.tsx', 'utf8');
const observabilityRoute = fs.readFileSync('app/api/admin/observability/route.ts', 'utf8');

const requiredPageMarkers = [
  'signal_prediction_completed',
  'correlationId',
  'finalDecision',
  'strategyGateAccepted',
  'riskTier',
  'marketRegime',
  'anomalyScore',
  'availableModelCount',
  'modelCount',
];

for (const marker of requiredPageMarkers) {
  if (!page.includes(marker)) {
    throw new Error(`[Signal Forensics invariant] missing page marker: ${marker}`);
  }
}

const requiredRouteMarkers = [
  'metadata',
  'correlation_id',
  'request_id',
  'model_id',
  'symbol',
  'created_at',
];

for (const marker of requiredRouteMarkers) {
  if (!observabilityRoute.includes(marker)) {
    throw new Error(`[Signal Forensics invariant] missing telemetry marker: ${marker}`);
  }
}

console.log('[Signal Forensics invariant] passed: persisted decision lineage and authoritative telemetry identifiers are present.');
