export type ChampionChallengerMetrics = {
  accuracy?: number | null;
  f1?: number | null;
};

export type PromotionGovernanceDecision = {
  eligible: boolean;
  reason: string;
  accuracyDelta: number | null;
  f1Delta: number | null;
};

function finiteMetric(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function evaluateChampionChallengerPromotion(
  candidate: { metrics?: ChampionChallengerMetrics | null },
  champion: { metrics?: ChampionChallengerMetrics | null } | null,
): PromotionGovernanceDecision {
  const candidateAccuracy = finiteMetric(candidate.metrics?.accuracy);
  const candidateF1 = finiteMetric(candidate.metrics?.f1);

  if (candidateAccuracy === null) {
    return { eligible: false, reason: 'Candidate is missing persisted validation accuracy.', accuracyDelta: null, f1Delta: null };
  }
  if (candidateF1 === null) {
    return { eligible: false, reason: 'Candidate is missing persisted validation F1.', accuracyDelta: null, f1Delta: null };
  }

  if (!champion) {
    return {
      eligible: true,
      reason: 'No production champion exists for this asset/horizon; candidate may establish the initial champion.',
      accuracyDelta: null,
      f1Delta: null,
    };
  }

  const championAccuracy = finiteMetric(champion.metrics?.accuracy);
  const championF1 = finiteMetric(champion.metrics?.f1);
  if (championAccuracy === null || championF1 === null) {
    return { eligible: false, reason: 'Current champion is missing comparable persisted validation metrics.', accuracyDelta: null, f1Delta: null };
  }

  const accuracyDelta = candidateAccuracy - championAccuracy;
  const f1Delta = candidateF1 - championF1;
  const eligible = accuracyDelta >= 0 && f1Delta >= 0 && (accuracyDelta > 0 || f1Delta > 0);

  return {
    eligible,
    reason: eligible
      ? 'Candidate strictly improves at least one persisted validation metric without regressing the other.'
      : 'Candidate does not strictly improve both governed validation metrics relative to the current champion.',
    accuracyDelta,
    f1Delta,
  };
}
