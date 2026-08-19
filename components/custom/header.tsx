'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { ShieldCheck, Settings, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { AdminAccessModal, useAdminGesture } from '@/components/custom/admin-access-modal';
import { TelegramPairModal } from '@/components/custom/telegram-pair-modal';
import { getStoredAdminToken } from '@/lib/admin-client-auth';
import type { AuthState, DerivAccount } from '@deriv/core';

interface HeaderProps {
  authState: AuthState;
  accounts: DerivAccount[];
  activeAccount: DerivAccount | null;
  onLogin: () => Promise<void>;
  onLogout: () => void;
  onSwitchAccount: (accountId: string) => Promise<void>;
  /** When provided, a Sign up button is rendered to the right of the Log in button. */
  onSignUp?: () => Promise<void>;
  /** Logo source URL or data URL. When omitted, a placeholder badge is shown until
   *  the user provides a logo via the app builder (passed as a data URL via PREVIEW_BRANDING). */
  logoSrc?: string;
  /** App name used to derive the fallback logo letter when no logoSrc is provided.
   *  Falls back to NEXT_PUBLIC_DERIV_APP_NAME env var, then 'Deriv Trading'. */
  appName?: string;
  /** Optional controls rendered to the left of the login/logout button (e.g. a theme toggle). */
  actions?: React.ReactNode;
}

function formatBalance(balance: string): string {
  return Number(balance).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function AccountLabel({ type }: { type: 'demo' | 'real' }) {
  return (
    <span
      className={cn(
        'text-sm font-medium',
        type === 'demo' ? 'text-orange-500' : 'text-emerald-600'
      )}
    >
      {type === 'demo' ? 'Demo account' : 'Real account'}
    </span>
  );
}

export function Header({
  authState,
  accounts,
  activeAccount,
  onLogin,
  onLogout,
  onSwitchAccount,
  onSignUp,
  logoSrc,
  appName,
  actions,
}: HeaderProps) {
  const [logoError, setLogoError] = useState(false);
  const logoLetter = (appName ?? process.env.NEXT_PUBLIC_DERIV_APP_NAME ?? 'Deriv Trading')
    .trim()
    .charAt(0)
    .toUpperCase() || 'D';
  const [accountSwitcherOpen, setAccountSwitcherOpen] = useState(false);
  const [adminModalOpen, setAdminModalOpen] = useState(false);
  const [telegramModalOpen, setTelegramModalOpen] = useState(false);
  const [hasAdminSession, setHasAdminSession] = useState(false);

  const isAuthenticated = authState === 'authenticated';
  const isAuthenticating = authState === 'authenticating';

  // Check if active user account or stored token has admin privileges
  useEffect(() => {
    const token = getStoredAdminToken();
    if (token) {
      setHasAdminSession(true);
      return;
    }
    // Check if account email or ID matches admin criteria
    const adminEmails = (process.env.NEXT_PUBLIC_ADMIN_EMAILS || 'olalekan4565@gmail.com').split(',').map((e) => e.trim().toLowerCase());
    const accountEmail = (activeAccount as unknown as { email?: string })?.email;
    if (accountEmail && adminEmails.includes(accountEmail.toLowerCase())) {
      setHasAdminSession(true);
    }
  }, [activeAccount]);

  // Discrete Touch & Press gesture hook attached to Header Logo/Title
  const gestureHandlers = useAdminGesture(() => {
    setAdminModalOpen(true);
  });

  return (
    <>
      <header className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-4 py-3 border-b bg-background/80 backdrop-blur-sm">
        <div
          {...gestureHandlers}
          className="flex items-center gap-3 cursor-pointer select-none touch-none active:opacity-80 transition-opacity"
          title="Deriv Trader Engine"
        >
          {!logoSrc || logoError ? (
            <div className="w-8 h-8 rounded-lg bg-slate-900 border border-red-500/30 flex items-center justify-center text-red-500 font-black text-sm shadow-md">
              <svg className="w-5 h-5" viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M 128 112 H 240 C 330 112 392 176 392 256 C 392 336 330 400 240 400 H 128 V 112 Z" fill="none" stroke="#FF444F" strokeWidth="48" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M 160 330 L 220 260 L 270 300 L 350 180" fill="none" stroke="#06B6D4" strokeWidth="36" strokeLinecap="round" strokeLinejoin="round"/>
                <circle cx="350" cy="180" r="20" fill="#38BDF8"/>
              </svg>
            </div>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element -- next/image is avoided here intentionally
            <img
              src={logoSrc}
              alt="App Logo"
              className="h-8 w-8 rounded-lg object-contain pointer-events-none"
              onError={() => setLogoError(true)}
            />
          )}
          <h1 className="text-lg font-semibold text-foreground hidden sm:block pointer-events-none">
            {process.env.NEXT_PUBLIC_DERIV_APP_NAME ?? 'Deriv Trading'}
          </h1>
        </div>
      <div className="flex items-center gap-2 sm:gap-3">
        {actions}
        {isAuthenticated && activeAccount && (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setTelegramModalOpen(true)}
              className="border-cyan-500/30 bg-cyan-500/10 text-cyan-400 hover:bg-cyan-500/20 hover:text-cyan-300 hover:border-cyan-500/50 transition-all font-medium text-xs gap-1.5 px-2.5 sm:px-3"
              title="Connect Telegram Bot"
            >
              <Send className="w-3.5 h-3.5 text-cyan-400" />
              <span className="hidden sm:inline">Connect Telegram</span>
            </Button>

            <Popover open={accountSwitcherOpen} onOpenChange={setAccountSwitcherOpen}>
              <PopoverTrigger asChild>
                <button className="flex items-center gap-2 rounded-lg border border-border px-3 hover:bg-muted/50 transition-colors">
                  <div className="text-left">
                    <AccountLabel type={activeAccount.account_type} />
                    <p className="text-base font-bold text-foreground">
                      {formatBalance(activeAccount.balance)} {activeAccount.currency}
                    </p>
                  </div>
                  <svg
                    className={cn(
                      'w-4 h-4 text-muted-foreground transition-transform',
                      accountSwitcherOpen && 'rotate-180'
                    )}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-64 p-2">
                <div className="space-y-1">
                  {accounts.map((account) => (
                    <button
                      key={account.account_id}
                      onClick={() => {
                        onSwitchAccount(account.account_id);
                        setAccountSwitcherOpen(false);
                      }}
                      className={cn(
                        'w-full text-left rounded-lg px-3 py-2.5 transition-colors',
                        account.account_id === activeAccount.account_id
                          ? 'bg-muted'
                          : 'hover:bg-muted/50'
                      )}
                    >
                      <AccountLabel type={account.account_type} />
                      <p className="text-base font-bold text-foreground">
                        {formatBalance(account.balance)} {account.currency}
                      </p>
                    </button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
          </>
        )}
        {isAuthenticated ? (
          <Button variant="outline" onClick={onLogout}>
            Log out
          </Button>
        ) : (
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={onLogin} disabled={isAuthenticating}>
              {isAuthenticating ? 'Logging in...' : 'Log in'}
            </Button>
            {onSignUp && (
              <Button size="sm" onClick={onSignUp} disabled={isAuthenticating}>
                Sign up
              </Button>
            )}
          </div>
        )}
      </div>
    </header>
    <AdminAccessModal open={adminModalOpen} onOpenChange={setAdminModalOpen} />
    <TelegramPairModal
      open={telegramModalOpen}
      onOpenChange={setTelegramModalOpen}
      activeAccount={activeAccount}
    />
    </>
  );
}
