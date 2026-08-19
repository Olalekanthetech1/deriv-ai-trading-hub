export function formatDurationLabel(duration: number, durationUnit: string): string {
  const u = durationUnit.toLowerCase();
  if (u === 't') return `${duration} Tick${duration > 1 ? 's' : ''}`;
  if (u === 's') return `${duration} Second${duration > 1 ? 's' : ''}`;
  if (u === 'm') return `${duration} Minute${duration > 1 ? 's' : ''}`;
  if (u === 'h') return `${duration} Hour${duration > 1 ? 's' : ''}`;
  if (u === 'd') return `${duration} Day${duration > 1 ? 's' : ''}`;
  return `${duration} ${durationUnit}`;
}

export function getPositionDurationLabel(pos: {
  tick_count?: number;
  date_start?: number;
  date_expiry?: number;
  purchase_time?: number;
  sell_time?: number;
  longcode?: string;
}): string {
  if (pos.tick_count && pos.tick_count > 0) {
    return `${pos.tick_count} Tick${pos.tick_count > 1 ? 's' : ''}`;
  }

  if (pos.longcode) {
    const tickMatch = pos.longcode.match(/after (\d+) ticks/i);
    if (tickMatch) return `${tickMatch[1]} Ticks`;
    const secMatch = pos.longcode.match(/after (\d+) seconds/i);
    if (secMatch) return `${secMatch[1]} Seconds`;
    const minMatch = pos.longcode.match(/after (\d+) minutes/i);
    if (minMatch) return `${minMatch[1]} Minute${Number(minMatch[1]) > 1 ? 's' : ''}`;
  }

  const start = pos.date_start ?? pos.purchase_time;
  const expiry = pos.date_expiry ?? pos.sell_time;

  if (start && expiry && expiry > start) {
    const diffSec = expiry - start;
    if (diffSec < 60) return `${diffSec} Second${diffSec !== 1 ? 's' : ''}`;
    if (diffSec < 3600) {
      const mins = Math.round(diffSec / 60);
      return `${mins} Minute${mins !== 1 ? 's' : ''}`;
    }
    if (diffSec < 86400) {
      const hours = Math.round(diffSec / 3600);
      return `${hours} Hour${hours !== 1 ? 's' : ''}`;
    }
    const days = Math.round(diffSec / 86400);
    return `${days} Day${days !== 1 ? 's' : ''}`;
  }

  return 'Spot Contract';
}
