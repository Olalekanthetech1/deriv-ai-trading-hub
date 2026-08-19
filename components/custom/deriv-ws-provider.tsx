'use client';

import { createContext, useContext, useEffect, useRef } from 'react';
import { useDerivWS } from '@deriv/core';
import { useAuth } from '@/hooks/use-auth';
import { ClientWSRateLimiter } from '@/lib/websocket-rate-limiter';
import type { DerivWS } from '@deriv/core';
import type { UseAuthReturn } from '@/hooks/use-auth';

interface DerivWSContextValue {
  ws: DerivWS | null;
  isConnected: boolean;
  isExhausted: boolean;
  auth: UseAuthReturn;
  isRateLimited: boolean;
  refreshBalance: () => Promise<void>;
}

const DerivWSContext = createContext<DerivWSContextValue | null>(null);

/**
 * Maintains a single WebSocket connection and auth state above all page components
 * so navigation between pages (e.g. main → reports → back) does not tear down
 * and recreate the connection.
 */
export function DerivWSProvider({ children }: { children: React.ReactNode }) {
  const auth = useAuth();
  const authRef = useRef(auth);
  authRef.current = auth;

  const rateLimiterRef = useRef(new ClientWSRateLimiter(3000, 60)); // 3000 msg / 60 sec (high-frequency ticks & trades)
  const { ws, isConnected, isExhausted } = useDerivWS({
    url: auth.wsUrl,
    accountId: auth.activeAccountId ?? undefined,
  });

  const activeAccountId = auth.activeAccount?.account_id || auth.activeAccountId;

  useEffect(() => {
    if (!ws || !isConnected || !activeAccountId) return;

    let isSubscribed = true;

    // Helper to safely update account balance across all handlers
    const handleBalanceUpdate = (targetAccountId: string | undefined, rawBalance: unknown) => {
      if (rawBalance === undefined || rawBalance === null) return;
      const numeric = typeof rawBalance === 'number' ? rawBalance : Number(rawBalance);
      if (Number.isFinite(numeric)) {
        const targetId = targetAccountId || activeAccountId;
        authRef.current.updateAccountBalance(targetId, numeric);
      }
    };

    // Listen globally for buy/sell/balance/transaction WS frames
    const unsub = ws.onMessage((data) => {
      // 1. Critical Financial & Balance Frames (NEVER rate-limited or dropped)
      if (data.msg_type === 'balance' || data.balance !== undefined) {
        if (typeof data.balance === 'number' || typeof data.balance === 'string') {
          handleBalanceUpdate(activeAccountId, data.balance);
        } else if (data.balance && typeof data.balance === 'object') {
          const balObj = data.balance as { balance?: number | string; loginid?: string };
          handleBalanceUpdate(balObj.loginid || activeAccountId, balObj.balance);
        }
        return;
      }

      if (data.buy && typeof data.buy === 'object') {
        const buyObj = data.buy as { balance_after?: number };
        if (buyObj.balance_after !== undefined) {
          handleBalanceUpdate(activeAccountId, buyObj.balance_after);
        }
      }

      if (data.sell && typeof data.sell === 'object') {
        const sellObj = data.sell as { balance_after?: number };
        if (sellObj.balance_after !== undefined) {
          handleBalanceUpdate(activeAccountId, sellObj.balance_after);
        }
      }

      if (data.transaction && typeof data.transaction === 'object') {
        const txObj = data.transaction as { balance?: number | string; loginid?: string };
        if (txObj.balance !== undefined) {
          handleBalanceUpdate(txObj.loginid || activeAccountId, txObj.balance);
        }
      }

      // 2. High-frequency non-financial frames (ticks, proposals, etc.)
      const allowed = rateLimiterRef.current.tryConsume(1);
      if (!allowed) {
        console.warn('[WS Rate Limiter] High frequency WebSocket traffic detected and throttled.');
        return;
      }
    });

    // Explicitly subscribe to real-time balance stream and transaction stream for the active account
    ws.send({ balance: 1, subscribe: 1 }).catch((err) => {
      console.warn('[Deriv WS] Balance stream subscription warning:', err);
    });

    ws.send({ transaction: 1, subscribe: 1 }).catch(() => {
      // transaction stream may require specific scope, non-fatal
    });

    // Also send an immediate one-shot query to ensure local balance matches backend at mount
    ws.send({ balance: 1 }).catch(() => {});

    return () => {
      isSubscribed = false;
      unsub();
      if (ws.isConnected) {
        ws.send({ forget_all: 'balance' }).catch(() => {});
      }
    };
  }, [ws, isConnected, activeAccountId]);

  const refreshBalance = async () => {
    if (!ws || !isConnected) return;
    try {
      await ws.send({ balance: 1 });
    } catch (err) {
      console.warn('[Deriv WS] Manual balance refresh error:', err);
    }
  };

  const isRateLimited = rateLimiterRef.current.getRemainingTokens() === 0;

  return (
    <DerivWSContext.Provider value={{ ws, isConnected, isExhausted, auth, isRateLimited, refreshBalance }}>
      {children}
    </DerivWSContext.Provider>
  );
}

export function useDerivWSContext(): DerivWSContextValue {
  const ctx = useContext(DerivWSContext);
  if (!ctx) {
    return {
      ws: null,
      isConnected: false,
      isExhausted: false,
      auth: {
        authState: 'unauthenticated',
        accounts: [],
        activeAccount: null,
        activeAccountId: null,
        wsUrl: '',
        error: null,
        isSwitchingAccount: false,
        isLoadingAccounts: false,
        login: () => {},
        signUp: () => {},
        logout: () => {},
        switchAccount: async () => {},
      } as unknown as UseAuthReturn,
      isRateLimited: false,
      refreshBalance: async () => {},
    };
  }
  return ctx;
}
