'use client';

import { useState, useEffect, useCallback } from 'react';
import type { DerivWS } from '@deriv/core';

export interface ClosedPosition {
  contract_id: number;
  contract_type: string;
  buy_price: number;
  sell_price: number;
  payout: number;
  longcode: string;
  underlying_symbol: string;
  purchase_time: number;
  sell_time: number;
  shortcode: string;
  transaction_id: number;
  duration_type: string | null;
}

interface ProfitTableResponse {
  profit_table: {
    count: number;
    transactions: ClosedPosition[];
  };
}

export function useClosedPositions(
  ws: DerivWS | null,
  isConnected: boolean,
  isAuthenticated: boolean
) {
  const [positions, setPositions] = useState<ClosedPosition[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const fetch = useCallback(async () => {
    if (!ws || !isConnected || !isAuthenticated) return;

    setIsLoading(true);
    try {
      const response = await ws.send<ProfitTableResponse>({
        profit_table: 1,
        description: 1,
        sort: 'DESC',
        limit: 50,
      });
      setPositions(response.profit_table?.transactions ?? []);
    } catch {
      // silent — table simply stays empty on error
    } finally {
      setIsLoading(false);
    }
  }, [ws, isConnected, isAuthenticated]);

  useEffect(() => {
    fetch();
  }, [fetch]);

  // Real-time listener: immediately prepend closed contract when proposal_open_contract or custom event fires
  useEffect(() => {
    const handleClosedContract = (contractData: any) => {
      if (!contractData || !contractData.contract_id) return;
      const buyPrice = parseFloat(contractData.buy_price) || 0;
      const profit = parseFloat(contractData.profit) || 0;
      const bidPrice = parseFloat(contractData.bid_price) || 0;
      const payout = parseFloat(contractData.payout) || 0;

      // Calculate realistic sell_price based on outcome
      let sellPrice = bidPrice;
      if (sellPrice === 0) {
        if (profit > 0) {
          sellPrice = payout > 0 ? payout : buyPrice + profit;
        } else {
          sellPrice = Math.max(0, buyPrice + profit);
        }
      }

      const newClosed: ClosedPosition = {
        contract_id: Number(contractData.contract_id),
        contract_type: contractData.contract_type || 'TRADE',
        buy_price: buyPrice,
        sell_price: sellPrice,
        payout: payout,
        longcode: contractData.longcode || '',
        underlying_symbol: contractData.underlying_symbol || '',
        purchase_time: contractData.date_start || Math.floor(Date.now() / 1000),
        sell_time: contractData.date_expiry || Math.floor(Date.now() / 1000),
        shortcode: contractData.barrier || '',
        transaction_id: Number(contractData.contract_id),
        duration_type: null,
      };

      setPositions((prev) => {
        // Upsert by contract_id at top of list
        const filtered = prev.filter((p) => p.contract_id !== newClosed.contract_id);
        return [newClosed, ...filtered];
      });

      // Refetch official profit table after brief delay to sync full server records
      const timer = setTimeout(() => {
        void fetch();
      }, 1000);

      return () => clearTimeout(timer);
    };

    // 1. Custom window event listener from open positions hook
    const windowEventListener = (e: Event) => {
      const customEvent = e as CustomEvent;
      if (customEvent.detail) {
        handleClosedContract(customEvent.detail);
      }
    };

    if (typeof window !== 'undefined') {
      window.addEventListener('deriv:contract_closed', windowEventListener);
    }

    // 2. Direct WebSocket listener backup
    let unsubWs: (() => void) | undefined;
    if (ws && isConnected) {
      unsubWs = ws.onMessage((data) => {
        if (data.msg_type !== 'proposal_open_contract') return;
        const contract = data.proposal_open_contract as any;
        if (!contract) return;
        const isClosed =
          !!contract.is_sold || !!contract.is_expired || contract.status !== 'open';
        if (isClosed) {
          handleClosedContract(contract);
        }
      });
    }

    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('deriv:contract_closed', windowEventListener);
      }
      if (unsubWs) unsubWs();
    };
  }, [ws, isConnected, fetch]);

  return { positions, isLoading, refresh: fetch };
}
