'use client';

import type { DerivWS, ProposalInfo, ProposalParams, ProposalResponse } from '@deriv/core';

/**
 * Central proposal request coordinator for a single Deriv WebSocket.
 *
 * Proposal subscriptions are deliberately NOT used here. The trading flow
 * only needs a valid proposal immediately before buying, and Deriv rejects
 * duplicate subscriptions with AlreadySubscribed. A one-shot proposal request
 * avoids that server-side subscription state while this manager still
 * deduplicates concurrent identical requests.
 */
export class ProposalSubmissionManager {
  private readonly ws: DerivWS;
  private pending = new Map<string, Promise<ProposalInfo | null>>();

  constructor(ws: DerivWS) {
    this.ws = ws;
  }

  private key(params: ProposalParams): string {
    return JSON.stringify({
      contractType: params.contractType,
      symbol: params.symbol,
      amount: params.amount,
      basis: params.basis,
      currency: params.currency,
      duration: params.duration,
      durationUnit: params.durationUnit,
      dateExpiry: params.dateExpiry,
      barrier: params.barrier,
    });
  }

  async getProposal(params: ProposalParams): Promise<ProposalInfo | null> {
    const key = this.key(params);
    const existing = this.pending.get(key);
    if (existing) return existing;

    const request = (async () => {
      try {
        const response = await this.ws.send<ProposalResponse>({
          proposal: 1,
          amount: params.amount,
          basis: params.basis,
          contract_type: params.contractType,
          currency: params.currency,
          symbol: params.symbol,
          ...(params.dateExpiry !== undefined
            ? { date_expiry: params.dateExpiry }
            : {
                duration: params.duration,
                duration_unit: params.durationUnit,
              }),
          ...(params.barrier !== undefined ? { barrier: params.barrier } : {}),
        });

        if (!response.proposal) return null;

        // Deriv returns snake_case proposal fields. Normalize them here to the
        // same ProposalInfo shape produced by the legacy useProposal hook.
        // This normalization is critical because useBuy expects askPrice, not
        // the raw Deriv ask_price field.
        const raw = response.proposal;
        const askPrice = Number(raw.ask_price);
        const payout = Number(raw.payout);
        const minStake = Number(raw.validation_params?.stake?.min ?? 0);
        const maxPayout = Number(raw.validation_params?.payout?.max ?? 0);

        if (!raw.id || !Number.isFinite(askPrice) || askPrice <= 0) {
          throw new Error('Deriv returned an invalid proposal price or proposal ID.');
        }

        return {
          id: raw.id,
          askPrice,
          payout: Number.isFinite(payout) ? payout : 0,
          longcode: raw.longcode ?? '',
          minStake: Number.isFinite(minStake) ? minStake : 0,
          maxPayout: Number.isFinite(maxPayout) ? maxPayout : 0,
        } satisfies ProposalInfo;
      } finally {
        this.pending.delete(key);
      }
    })();

    this.pending.set(key, request);
    return request;
  }

  clear(): void {
    this.pending.clear();
  }
}
