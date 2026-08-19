'use client';

import { useState } from 'react';
import { Send, CheckCircle, ExternalLink, Loader2, ShieldCheck, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { getAuthInfo } from '@deriv/core';
import type { DerivAccount } from '@deriv/core';

interface TelegramPairModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activeAccount: DerivAccount | null;
}

export function TelegramPairModal({ open, onOpenChange, activeAccount }: TelegramPairModalProps) {
  const [loading, setLoading] = useState(false);
  const [deepLink, setDeepLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleGenerateLink = async () => {
    if (!activeAccount) {
      setError('Please log in to your Deriv account first.');
      return;
    }
    setLoading(true);
    setError(null);

    try {
      // Seamless token discovery from OAuth session
      const authInfo = getAuthInfo();
      const token =
        authInfo?.access_token ||
        (activeAccount as any).token ||
        (activeAccount as any).token_value ||
        (typeof window !== 'undefined'
          ? localStorage.getItem(`deriv_token_${activeAccount.account_id}`) ||
            localStorage.getItem('deriv_auth_token') ||
            ''
          : '');

      if (!token) {
        throw new Error('Your active login session is not authenticated. Please log in to Deriv.');
      }

      const res = await fetch('/api/telegram/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_id: activeAccount.account_id,
          token: token,
          account_type: activeAccount.account_type,
          currency: activeAccount.currency,
          email: (activeAccount as any).email || null,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to generate Telegram pairing link');
      }

      setDeepLink(data.deep_link);
      // Automatically open Telegram deep-link
      if (typeof window !== 'undefined') {
        window.open(data.deep_link, '_blank');
      }
    } catch (err: any) {
      setError(err.message || 'An error occurred while connecting to Telegram.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md bg-slate-950 border-slate-800 text-slate-100">
        <DialogHeader>
          <div className="flex items-center gap-2 mb-1">
            <div className="w-8 h-8 rounded-full bg-cyan-500/10 flex items-center justify-center border border-cyan-500/30">
              <Send className="w-4 h-4 text-cyan-400" />
            </div>
            <DialogTitle className="text-lg font-bold">Connect Telegram Trading Bot</DialogTitle>
          </div>
          <DialogDescription className="text-xs text-slate-400">
            Trade Volatility Indices directly from Telegram with interactive execution and real-time microstructure signals.
          </DialogDescription>
        </DialogHeader>

        <div className="py-2 space-y-4">
          <div className="rounded-lg bg-slate-900/80 border border-slate-800 p-3 space-y-2 text-xs">
            <div className="flex justify-between items-center text-slate-400">
              <span>Account to Pair:</span>
              <span className="font-semibold text-slate-200">{activeAccount?.account_id || 'Not logged in'}</span>
            </div>
            <div className="flex justify-between items-center text-slate-400">
              <span>Trading Mode:</span>
              <span className="font-semibold text-cyan-400 uppercase">{activeAccount?.account_type || 'Demo'}</span>
            </div>
            <div className="flex justify-between items-center text-slate-400">
              <span>Security & Encryption:</span>
              <span className="text-emerald-400 font-medium flex items-center gap-1">
                <ShieldCheck className="w-3.5 h-3.5" /> AES-256-GCM Vault
              </span>
            </div>
          </div>

          <div className="space-y-3">
            <p className="text-[11px] text-slate-400">
              Seamless 1-click link syncs your current Deriv OAuth session instantly. No manual tokens or API key copying required.
            </p>

            {deepLink ? (
              <div className="rounded-lg bg-emerald-950/40 border border-emerald-800/60 p-3 text-center space-y-2">
                <div className="flex items-center justify-center gap-1.5 text-emerald-400 font-semibold text-sm">
                  <CheckCircle className="w-4 h-4" /> Link Generated & Ready
                </div>
                <p className="text-[11px] text-slate-400">
                  Tap below to open Telegram and start trading immediately:
                </p>
                <Button
                  asChild
                  className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-medium text-xs gap-1.5 mt-2"
                >
                  <a href={deepLink} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="w-3.5 h-3.5" /> Open in Telegram
                  </a>
                </Button>
              </div>
            ) : (
              <Button
                onClick={() => handleGenerateLink()}
                disabled={loading || !activeAccount}
                className="w-full bg-cyan-600 hover:bg-cyan-500 text-white font-semibold text-xs gap-1.5 py-5 shadow-lg shadow-cyan-950/50"
              >
                {loading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" /> Generating Secure Pairing Link...
                  </>
                ) : (
                  <>
                    <Zap className="w-4 h-4" /> 1-Click Connect to Telegram
                  </>
                )}
              </Button>
            )}
          </div>

          {error && (
            <div className="rounded-lg bg-red-950/50 border border-red-800/80 p-2.5 text-xs text-red-300">
              {error}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

