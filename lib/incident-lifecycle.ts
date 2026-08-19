export type IncidentStatus = 'open' | 'acknowledged' | 'investigating' | 'resolved';

const validStatuses = new Set<IncidentStatus>([
  'open',
  'acknowledged',
  'investigating',
  'resolved',
]);

export function normalizeIncidentStatus(value: unknown): IncidentStatus | null {
  const status = String(value ?? '').toLowerCase() as IncidentStatus;
  return validStatuses.has(status) ? status : null;
}

export function canTransitionIncident(
  from: IncidentStatus,
  to: IncidentStatus,
): boolean {
  if (from === to) return true;
  if (from === 'open') {
    return to === 'acknowledged' || to === 'investigating' || to === 'resolved';
  }
  if (from === 'acknowledged') {
    return to === 'investigating' || to === 'resolved';
  }
  if (from === 'investigating') {
    return to === 'resolved';
  }
  return to === 'open';
}
