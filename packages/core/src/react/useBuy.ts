'use client';

import { useState, useCallback } from 'react';
import type { DerivWS } from '../ws';
import type { ProposalInfo, BuyResponse, BuyResult } from '../types';

interface UseBuyReturn {
  buyContract: (proposal: ProposalInfo) => Promise<void>;
  isBuying: boolean;
  buyResult: BuyResult | null;
  buyError: string | null;
  clearBuyResult: () => void;
}

export function useBuy(
  ws: DerivWS | null,
  isConnected: boolean
): UseBuyReturn {
  const [isBuying, setIsBuying] = useState(false);
  const [buyResult, setBuyResult] = useState<BuyResult | null>(null);
  const [buyError, setBuyError] = useState<string | null>(null);

  const clearBuyResult = useCallback(() => {
    setBuyResult(null);
    setBuyError(null);
  }, []);

  const buyContract = useCallback(async (proposal: ProposalInfo) => {
    if (!ws || !isConnected) {
      const error = new Error('WebSocket is not connected. Unable to purchase contract.');
      setBuyError(error.message);
      throw error;
    }

    if (!proposal?.id || !Number.isFinite(Number(proposal.askPrice)) || Number(proposal.askPrice) <= 0) {
      const error = new Error('Invalid Deriv proposal: proposal ID or ask price is missing.');
      setBuyError(error.message);
      throw error;
    }

    setIsBuying(true);
    setBuyError(null);
    setBuyResult(null);

    try {
      const response = await ws.send<BuyResponse>({
        buy: proposal.id,
        price: String(proposal.askPrice),
      });

      if (!response.buy?.contract_id) {
        throw new Error('Deriv accepted the buy request without returning a contract ID.');
      }

      const result: BuyResult = {
        contractId: response.buy.contract_id,
        buyPrice: response.buy.buy_price,
        payout: response.buy.payout,
        longcode: response.buy.longcode,
        balanceAfter: response.buy.balance_after,
      };

      setBuyResult(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Purchase failed';
      setBuyError(message);
      throw err instanceof Error ? err : new Error(message);
    } finally {
      setIsBuying(false);
    }
  }, [ws, isConnected]);

  return { buyContract, isBuying, buyResult, buyError, clearBuyResult };
}
