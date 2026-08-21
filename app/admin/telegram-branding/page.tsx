'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { adminFetch } from '@/lib/admin-client-auth';
import {
  Image,
  Save,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  Link as LinkIcon,
  Trash2,
  Sparkles,
} from 'lucide-react';

interface ScreenDef {
  key: string;
  title: string;
  description: string;
  placeholder: string;
}

const SCREENS: ScreenDef[] = [
  {
    key: 'main_menu',
    title: 'Main Menu (TELEGRAM_MAIN_MENU_IMAGE_URL)',
    description: 'Primary banner shown on the main menu /start dashboard.',
    placeholder: 'https://example.com/branding/main_menu.jpg',
  },
  {
    key: 'trade_mode_select',
    title: 'Trading Mode Selection',
    description: 'Banner shown when choosing between Single Trade and Automated Strategy.',
    placeholder: 'https://example.com/branding/trade_mode.jpg',
  },
  {
    key: 'asset_select',
    title: 'Asset Selection Leaderboard',
    description: 'Banner shown on the market analysis and asset leaderboard screen.',
    placeholder: 'https://example.com/branding/asset_select.jpg',
  },
  {
    key: 'ai_analyzing',
    title: 'AI Analyzing the Market',
    description: 'Banner shown while the AI engine scans market data and ranks signals.',
    placeholder: 'https://example.com/branding/ai_analyzing.jpg',
  },
  {
    key: 'signal_bullish',
    title: 'Bullish AI Signal (TELEGRAM_BULLISH_IMAGE_URL)',
    description: 'Banner displayed on RISE / CALL signal execution cards.',
    placeholder: 'https://example.com/branding/bullish_signal.jpg',
  },
  {
    key: 'signal_bearish',
    title: 'Bearish AI Signal (TELEGRAM_BEARISH_IMAGE_URL)',
    description: 'Banner displayed on FALL / PUT signal execution cards.',
    placeholder: 'https://example.com/branding/bearish_signal.jpg',
  },
  {
    key: 'trade_profit',
    title: 'Session Profit (TELEGRAM_PROFIT_IMAGE_URL)',
    description: 'Victory banner shown when a trade session finishes in positive net profit.',
    placeholder: 'https://example.com/branding/profit.jpg',
  },
  {
    key: 'trade_lost',
    title: 'Session Loss (TELEGRAM_LOST_IMAGE_URL)',
    description: 'Banner shown when a trade session ends with a deficit or full loss.',
    placeholder: 'https://example.com/branding/lost.jpg',
  },
  {
    key: 'account_screen',
    title: 'My Account (TELEGRAM_MY_ACCOUNT_IMAGE_URL)',
    description: 'Banner shown on the user account overview and balance screen.',
    placeholder: 'https://example.com/branding/account.jpg',
  },
  {
    key: 'insufficient_balance',
    title: 'Insufficient Balance (TELEGRAM_INSUFFICIENT_BALANCE_IMAGE_URL)',
    description: 'Banner shown when available balance is less than required stake for the current recovery step.',
    placeholder: 'https://example.com/branding/insufficient_balance.jpg',
  },
  {
    key: 'unlinked_screen',
    title: 'Session Expired / Unlinked Account (TELEGRAM_SESSION_EXPIRED_IMAGE_URL)',
    description: 'Banner shown when API token is invalid, expired, or account is unlinked.',
    placeholder: 'https://example.com/branding/session_expired.jpg',
  },
  {
    key: 'trade_execution_error',
    title: 'Trade Execution Error (TELEGRAM_TRADE_EXECUTION_ERROR_IMAGE_URL)',
    description: 'Banner shown when broker rejects a trade for operational or market reasons.',
    placeholder: 'https://example.com/branding/execution_error.jpg',
  },
  {
    key: 'settings_screen',
    title: 'Settings (TELEGRAM_SETTINGS_IMAGE_URL)',
    description: 'Banner shown on settings, autotrade presets, and duration menus.',
    placeholder: 'https://example.com/branding/settings.jpg',
  },
  {
    key: 'faq_screen',
    title: 'FAQ & Guide (TELEGRAM_FAQ_IMAGE_URL)',
    description: 'Banner shown when viewing the FAQ and help guide.',
    placeholder: 'https://example.com/branding/faq.jpg',
  },
  {
    key: 'cashier_screen',
    title: 'Cashier & Deposit Portal',
    description: 'Banner for deposit and cashier portal navigation screens.',
    placeholder: 'https://example.com/branding/cashier.jpg',
  },
  {
    key: 'support_screen',
    title: 'Live Support Screen',
    description: 'Banner shown when prompting the user to send a support message.',
    placeholder: 'https://example.com/branding/support.jpg',
  },
];

export default function TelegramBrandingPage() {
  const [branding, setBranding] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const fetchBranding = async () => {
    setLoading(true);
    setStatusMessage(null);
    try {
      const res = await adminFetch('/api/admin/telegram-branding');
      const data = await res.json();
      if (data.success && data.config) {
        setBranding(data.config);
      } else {
        setStatusMessage({ type: 'error', text: data.error || 'Failed to load Telegram branding.' });
      }
    } catch (err: any) {
      setStatusMessage({ type: 'error', text: err?.message || 'Error connecting to admin API.' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchBranding();
  }, []);

  const handleChange = (key: string, url: string) => {
    setBranding((prev) => ({
      ...prev,
      [key]: url,
    }));
  };

  const handleClear = (key: string) => {
    setBranding((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setStatusMessage(null);

    try {
      const res = await adminFetch('/api/admin/telegram-branding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branding }),
      });
      const data = await res.json();

      if (data.success && data.config) {
        setBranding(data.config);
        setStatusMessage({ type: 'success', text: 'Telegram branding configuration successfully saved and updated live!' });
      } else {
        setStatusMessage({ type: 'error', text: data.error || 'Failed to save branding updates.' });
      }
    } catch (err: any) {
      setStatusMessage({ type: 'error', text: err?.message || 'Error saving branding updates.' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="min-h-screen bg-[#05070b] px-4 py-8 text-slate-100">
      <div className="mx-auto max-w-5xl">
        <div className="flex items-center justify-between gap-4">
          <Link href="/admin" className="text-xs text-cyan-300 hover:underline">
            ← Back to Operations Center
          </Link>
          <button
            onClick={() => void fetchBranding()}
            disabled={loading}
            className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-300 hover:bg-white/10"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>

        <header className="mt-5 rounded-3xl border border-white/10 bg-white/[0.03] p-6">
          <div className="flex items-center gap-3">
            <div className="rounded-xl border border-cyan-400/20 bg-cyan-400/10 p-2 text-cyan-300">
              <Image className="h-6 w-6" />
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan-300">
                Dynamic Bot Media
              </p>
              <h1 className="text-2xl font-black tracking-tight text-white">Telegram Bot Branding Config</h1>
            </div>
          </div>
          <p className="mt-3 text-sm leading-6 text-slate-400">
            Configure dynamic image URLs for each Telegram bot screen. The bot automatically updates banner photos in real-time when users navigate through menus. Leaving an image URL empty will gracefully revert that screen to text-only mode.
          </p>
        </header>

        {statusMessage && (
          <div
            className={`mt-4 flex items-center gap-2.5 rounded-xl border p-4 text-xs font-medium ${
              statusMessage.type === 'success'
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                : 'border-rose-500/30 bg-rose-500/10 text-rose-300'
            }`}
          >
            {statusMessage.type === 'success' ? (
              <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
            ) : (
              <AlertCircle className="h-4 w-4 shrink-0 text-rose-400" />
            )}
            <span>{statusMessage.text}</span>
          </div>
        )}

        <form onSubmit={handleSave} className="mt-6 space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            {SCREENS.map((screen) => {
              const currentUrl = branding[screen.key] || '';
              return (
                <div
                  key={screen.key}
                  className="flex flex-col justify-between rounded-2xl border border-white/10 bg-white/[0.025] p-4 transition hover:border-white/20"
                >
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="text-sm font-bold text-white">{screen.title}</h3>
                      <span className="rounded bg-slate-800 px-2 py-0.5 text-[10px] font-mono text-cyan-300">
                        {screen.key}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-slate-400">{screen.description}</p>

                    <div className="mt-3 flex items-center gap-2">
                      <div className="relative flex-1">
                        <LinkIcon className="absolute left-3 top-2.5 h-3.5 w-3.5 text-slate-500" />
                        <input
                          type="url"
                          value={currentUrl}
                          onChange={(e) => handleChange(screen.key, e.target.value)}
                          placeholder={screen.placeholder}
                          className="w-full rounded-xl border border-white/10 bg-slate-900/80 py-2 pl-9 pr-3 text-xs text-slate-200 placeholder-slate-600 focus:border-cyan-400 focus:outline-none"
                        />
                      </div>
                      {currentUrl && (
                        <button
                          type="button"
                          onClick={() => handleClear(screen.key)}
                          className="rounded-xl border border-rose-500/20 bg-rose-500/10 p-2 text-rose-400 hover:bg-rose-500/20"
                          title="Clear URL"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Image Preview */}
                  <div className="mt-3 overflow-hidden rounded-xl border border-white/10 bg-slate-950/60 p-2">
                    {currentUrl ? (
                      <div className="relative aspect-[16/9] w-full overflow-hidden rounded-lg bg-black">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={currentUrl}
                          alt={screen.title}
                          className="h-full w-full object-cover"
                          onError={(e) => {
                            (e.target as HTMLElement).style.display = 'none';
                          }}
                        />
                        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-1.5 text-[10px] text-slate-300">
                          Live Banner Preview
                        </div>
                      </div>
                    ) : (
                      <div className="flex h-20 items-center justify-center text-[11px] text-slate-600 italic">
                        No branding image configured (Text-only mode)
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="sticky bottom-6 mt-8 flex items-center justify-between rounded-2xl border border-cyan-400/20 bg-slate-900/90 p-4 shadow-2xl backdrop-blur-md">
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <Sparkles className="h-4 w-4 text-cyan-400" />
              <span>Changes apply instantly across all active Telegram sessions via dynamic cache.</span>
            </div>
            <button
              type="submit"
              disabled={saving}
              className="flex items-center gap-2 rounded-xl bg-cyan-500 px-5 py-2.5 text-xs font-bold text-slate-950 transition hover:bg-cyan-400 disabled:opacity-50"
            >
              <Save className="h-4 w-4" />
              {saving ? 'Saving...' : 'Save Branding Config'}
            </button>
          </div>
        </form>
      </div>
    </main>
  );
}
