'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { WifiOff, RefreshCw, Smartphone, ShieldAlert, ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function OfflinePage() {
  const [isOnline, setIsOnline] = useState(false);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    setIsOnline(navigator.onLine);

    const handleOnline = () => {
      setIsOnline(true);
      window.location.href = '/';
    };

    const handleOffline = () => {
      setIsOnline(false);
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const handleRetry = () => {
    setChecking(true);
    if (navigator.onLine) {
      window.location.href = '/';
    } else {
      setTimeout(() => setChecking(false), 800);
    }
  };

  return (
    <div className="min-h-screen bg-[#090d16] text-slate-100 flex flex-col items-center justify-center p-4">
      <div className="max-w-md w-full bg-slate-900/90 border border-slate-800 rounded-2xl p-6 sm:p-8 shadow-2xl backdrop-blur-xl text-center space-y-6">
        <div className="mx-auto w-16 h-16 rounded-full bg-rose-500/10 border border-rose-500/20 flex items-center justify-center text-rose-400">
          <WifiOff className="w-8 h-8 animate-pulse" />
        </div>

        <div className="space-y-2">
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/20">
            <ShieldAlert className="w-3.5 h-3.5" /> PWA Offline Engine
          </span>
          <h1 className="text-2xl font-bold tracking-tight text-white">Connection Lost</h1>
          <p className="text-sm text-slate-400 leading-relaxed">
            You are currently offline. The trading engine requires an active network connection for live WebSocket execution and market tick feeds.
          </p>
        </div>

        <div className="bg-slate-950/60 rounded-xl p-4 border border-slate-800 text-left space-y-2.5 text-xs text-slate-300">
          <div className="flex items-center justify-between font-mono">
            <span className="text-slate-400">Offline Status:</span>
            <span className="text-rose-400 font-bold">DISCONNECTED</span>
          </div>
          <div className="flex items-center justify-between font-mono">
            <span className="text-slate-400">PWA Cache Shell:</span>
            <span className="text-emerald-400 font-bold">READY</span>
          </div>
          <div className="flex items-center justify-between font-mono">
            <span className="text-slate-400">Auto Reconnect:</span>
            <span className="text-sky-400 font-bold">ACTIVE</span>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row items-center gap-3 pt-2">
          <Button
            onClick={handleRetry}
            disabled={checking}
            className="w-full bg-rose-600 hover:bg-rose-500 text-white font-semibold py-2.5 rounded-xl transition-all flex items-center justify-center gap-2"
          >
            <RefreshCw className={`w-4 h-4 ${checking ? 'animate-spin' : ''}`} />
            {checking ? 'Checking Connection...' : 'Retry Connection'}
          </Button>

          <Link href="/" className="w-full">
            <Button
              variant="outline"
              className="w-full border-slate-700 hover:bg-slate-800 text-slate-200 py-2.5 rounded-xl flex items-center justify-center gap-2"
            >
              <ArrowLeft className="w-4 h-4" /> Home Shell
            </Button>
          </Link>
        </div>

        <div className="pt-2 text-[11px] text-slate-500 flex items-center justify-center gap-1.5">
          <Smartphone className="w-3.5 h-3.5 text-slate-400" />
          <span>Deriv Progressive Web App · Auto-reconnects when network restores</span>
        </div>
      </div>
    </div>
  );
}
