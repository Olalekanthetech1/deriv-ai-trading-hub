'use client';

import Link from 'next/link';
import { useEffect, useState, useMemo, type ComponentType, type FormEvent } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  BarChart3,
  Beaker,
  BrainCircuit,
  CheckCircle2,
  Database,
  FileCheck2,
  FlaskConical,
  Gauge,
  KeyRound,
  Layers,
  Lock,
  LogOut,
  Moon,
  Cpu,
  Power,
  Radio,
  RefreshCw,
  Rocket,
  Search,
  Server,
  ShieldAlert,
  ShieldCheck,
  Sun,
  Sparkles,
  TerminalSquare,
  Trash2,
  X,
} from 'lucide-react';
import AdminDashboardOverview from '@/components/admin/admin-dashboard-overview';
import { adminDomains, adminRoadmap, type RoadmapDomainId, type RoadmapSection } from '@/lib/admin-roadmap';
import { adminFetch, setStoredAdminToken } from '@/lib/admin-client-auth';

type AdminSection = RoadmapSection & { icon: ComponentType<{ className?: string }> };

const iconMap: Record<string, ComponentType<{ className?: string }>> = {
  'command-center': Gauge,
  'operational-intelligence': BrainCircuit,
  observability: Activity,
  'incident-center': AlertTriangle,
  'signal-forensics': ShieldAlert,
  tradeability: ShieldCheck,
  'model-deployment': Rocket,
  models: BarChart3,
  'ml-config': TerminalSquare,
  'training-pipeline': BarChart3,
  retraining: RefreshCw,
  'horizon-audit': Sparkles,
  'champion-challenger': CheckCircle2,
  'prediction-integration': Gauge,
  'model-artifacts': FileCheck2,
  'model-cleanup': Trash2,
  'market-data-ingestion': Radio,
  'asset-strategy': BrainCircuit,
  'dataset-builder': Beaker,
  experiments: FlaskConical,
  intelligence: BrainCircuit,
  'final-verification': ShieldCheck,
  security: KeyRound,
  database: Database,
  infrastructure: Server,
  'worker-control': Cpu,
};

const sections: AdminSection[] = adminRoadmap.map((section) => ({
  ...section,
  icon: iconMap[section.id] ?? TerminalSquare,
}));

function StatusBadge({ status }: { status: AdminSection['status'] }) {
  const label = status === 'complete' ? 'COMPLETE' : status === 'next' ? 'NEXT' : 'PLANNED';
  return (
    <span
      className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold tracking-wider ${
        status === 'complete'
          ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-300'
          : status === 'next'
          ? 'border-cyan-400/20 bg-cyan-400/10 text-cyan-200'
          : 'border-white/10 bg-white/5 text-slate-300'
      }`}
    >
      {label}
    </span>
  );
}

export default function AdminOperationsShell() {
  const [authChecking, setAuthChecking] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [passkey, setPasskey] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLightTheme, setIsLightTheme] = useState(false);

  // Quick filter & search states
  const [searchQuery, setSearchQuery] = useState('');
  const [activeDomainFilter, setActiveDomainFilter] = useState<'all' | RoadmapDomainId>('all');

  useEffect(() => {
    const saved = window.localStorage.getItem('admin-theme');
    const light = saved === 'light';
    setIsLightTheme(light);
    document.documentElement.classList.toggle('admin-theme-light', light);
    return () => document.documentElement.classList.remove('admin-theme-light');
  }, []);

  const toggleTheme = () => {
    setIsLightTheme((current) => {
      const next = !current;
      window.localStorage.setItem('admin-theme', next ? 'light' : 'dark');
      document.documentElement.classList.toggle('admin-theme-light', next);
      return next;
    });
  };

  const checkSession = async () => {
    setAuthChecking(true);
    try {
      const response = await adminFetch('/api/admin/auth', { cache: 'no-store' });
      const data = await response.json();
      setIsAuthenticated(Boolean(data?.isAuthenticated));
    } catch {
      setIsAuthenticated(false);
    } finally {
      setAuthChecking(false);
    }
  };
  useEffect(() => {
    void checkSession();
  }, []);

  const handleLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!passkey.trim()) {
      setAuthError('Enter the admin passkey.');
      return;
    }
    setIsSubmitting(true);
    setAuthError(null);
    try {
      const response = await fetch('/api/admin/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: passkey }),
      });
      const data = await response.json();
      if (!response.ok || !data?.success) {
        setAuthError(data?.error || 'Authentication failed.');
        return;
      }
      if (data?.token) {
        setStoredAdminToken(data.token);
      }
      setPasskey('');
      setIsAuthenticated(true);
    } catch {
      setAuthError('Unable to reach the authentication service.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleLogout = async () => {
    try {
      await adminFetch('/api/admin/auth', { method: 'DELETE' });
    } finally {
      setStoredAdminToken(null);
      setIsAuthenticated(false);
    }
  };

  // Filter sections dynamically by search query and domain pill filter
  const filteredSections = useMemo(() => {
    return sections.filter((section) => {
      const matchesDomain = activeDomainFilter === 'all' || section.domainId === activeDomainFilter;
      const q = searchQuery.trim().toLowerCase();
      const matchesQuery =
        !q ||
        section.title.toLowerCase().includes(q) ||
        section.description.toLowerCase().includes(q) ||
        section.id.toLowerCase().includes(q);
      return matchesDomain && matchesQuery;
    });
  }, [searchQuery, activeDomainFilter]);

  // Group filtered sections by domain
  const groupedDomains = useMemo(() => {
    return adminDomains
      .filter((domain) => activeDomainFilter === 'all' || domain.id === activeDomainFilter)
      .map((domain) => {
        const domainSections = filteredSections.filter((s) => s.domainId === domain.id);
        const totalInDomain = sections.filter((s) => s.domainId === domain.id);
        const completeCount = totalInDomain.filter((s) => s.status === 'complete').length;
        const nextCount = totalInDomain.filter((s) => s.status === 'next').length;
        return {
          ...domain,
          sections: domainSections,
          totalCount: totalInDomain.length,
          completeCount,
          nextCount,
        };
      });
  }, [filteredSections, activeDomainFilter]);

  if (authChecking)
    return (
      <main className="min-h-screen bg-[#05070b] text-slate-100 admin-dashboard-surface">
        <div className="mx-auto flex min-h-screen max-w-7xl items-center justify-center px-4">
          <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.03] px-5 py-4 text-sm text-slate-300">
            <RefreshCw className="h-4 w-4 animate-spin" />
            Verifying admin session…
          </div>
        </div>
      </main>
    );

  if (!isAuthenticated)
    return (
      <main className="min-h-screen bg-[#05070b] px-4 py-10 text-slate-100 admin-dashboard-surface">
        <div className="mx-auto flex min-h-[80vh] max-w-md items-center">
          <form
            onSubmit={handleLogin}
            className="w-full rounded-3xl border border-white/10 bg-white/[0.035] p-6 shadow-2xl shadow-black/30 backdrop-blur-xl sm:p-8"
          >
            <div className="mb-7 flex items-center gap-3">
              <div className="rounded-2xl border border-cyan-400/20 bg-cyan-400/10 p-3">
                <Lock className="h-6 w-6 text-cyan-300" />
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-300">Admin Operations</p>
                <h1 className="text-xl font-bold">Secure Console</h1>
              </div>
            </div>
            <p className="mb-6 text-sm leading-6 text-slate-400">
              Authentication is required before accessing production administration tools.
            </p>
            <input
              type="password"
              value={passkey}
              onChange={(event) => setPasskey(event.target.value)}
              autoComplete="current-password"
              placeholder="Admin passkey"
              className="mb-3 w-full rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm outline-none transition focus:border-cyan-400/50"
            />
            {authError && <p className="mb-3 text-xs text-red-300">{authError}</p>}
            <button
              disabled={isSubmitting}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-cyan-400 px-4 py-3 text-sm font-bold text-slate-950 transition hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSubmitting ? <RefreshCw className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
              {isSubmitting ? 'Authorizing…' : 'Unlock Admin Console'}
            </button>
          </form>
        </div>
      </main>
    );

  return (
    <main className="min-h-screen bg-[#05070b] text-slate-100 admin-dashboard-surface">
      <div className="mx-auto max-w-[1600px] px-4 py-5 sm:px-6 lg:px-8">
        <header className="mb-6 flex flex-col gap-4 rounded-3xl border border-white/10 bg-white/[0.03] p-5 shadow-2xl shadow-black/20 backdrop-blur-xl sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="rounded-2xl border border-cyan-400/20 bg-cyan-400/10 p-3">
              <TerminalSquare className="h-6 w-6 text-cyan-300" />
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan-300">AI Trader</p>
              <h1 className="text-2xl font-black tracking-tight sm:text-3xl">Admin Operations Center</h1>
              <p className="mt-1 text-xs text-slate-500">
                5B · Modular domain architecture · {adminDomains.length} Operational Domains · {adminRoadmap.length} Modules
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={toggleTheme}
              type="button"
              aria-label={isLightTheme ? 'Switch admin dashboard to dark theme' : 'Switch admin dashboard to light theme'}
              title={isLightTheme ? 'Dark theme' : 'Light theme'}
              className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-slate-300 transition hover:bg-white/10"
            >
              <span className="rounded-md bg-black/20 p-1">
                {isLightTheme ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
              </span>
              {isLightTheme ? 'Dark' : 'Light'}
            </button>
            <Link
              href="/admin/market-data-ingestion"
              className="inline-flex items-center gap-2 rounded-xl border border-cyan-400/20 bg-cyan-400/5 px-3 py-2 text-xs font-semibold text-cyan-200 transition hover:bg-cyan-400/10"
            >
              <Radio className="h-4 w-4" />
              Market Data
            </Link>
            <Link
              href="/admin/command-center"
              className="inline-flex items-center gap-2 rounded-xl border border-cyan-400/20 bg-cyan-400/5 px-3 py-2 text-xs font-semibold text-cyan-200 transition hover:bg-cyan-400/10"
            >
              <Gauge className="h-4 w-4" />
              Command Center
            </Link>
            <Link
              href="/admin/model-deployment"
              className="inline-flex items-center gap-2 rounded-xl border border-cyan-400/20 bg-cyan-400/5 px-3 py-2 text-xs font-semibold text-cyan-200 transition hover:bg-cyan-400/10"
            >
              <Rocket className="h-4 w-4" />
              Model Deployment
            </Link>
            <Link
              href="/admin/models"
              className="inline-flex items-center gap-2 rounded-xl border border-cyan-400/20 bg-cyan-400/5 px-3 py-2 text-xs font-semibold text-cyan-200 transition hover:bg-cyan-400/10"
            >
              <BarChart3 className="h-4 w-4" />
              Model Operations
            </Link>
            <button
              onClick={handleLogout}
              className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-slate-300 transition hover:bg-white/10"
            >
              <LogOut className="h-4 w-4" />
              Lock Session
            </button>
          </div>
        </header>

        <AdminDashboardOverview />

        {/* Filter Controls & Search Section */}
        <section className="sticky top-2 z-20 mb-8 rounded-2xl border border-white/10 bg-[#080b11]/90 p-3 shadow-xl backdrop-blur-md sm:p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            {/* Quick Filter Pills */}
            <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
              <button
                onClick={() => setActiveDomainFilter('all')}
                className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-bold transition ${
                  activeDomainFilter === 'all'
                    ? 'bg-cyan-400 text-slate-950 shadow-md shadow-cyan-400/20'
                    : 'border border-white/10 bg-white/5 text-slate-300 hover:bg-white/10'
                }`}
              >
                <Layers className="h-3.5 w-3.5" />
                All Domains
                <span
                  className={`ml-1 rounded-full px-1.5 py-0.5 text-[10px] font-black ${
                    activeDomainFilter === 'all' ? 'bg-slate-950/20 text-slate-950' : 'bg-white/10 text-slate-300'
                  }`}
                >
                  {sections.length}
                </span>
              </button>

              {adminDomains.map((domain) => {
                const isActive = activeDomainFilter === domain.id;
                const domainSectionsCount = sections.filter((s) => s.domainId === domain.id).length;
                return (
                  <button
                    key={domain.id}
                    onClick={() => setActiveDomainFilter(domain.id)}
                    className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold transition ${
                      isActive
                        ? 'bg-cyan-400 text-slate-950 shadow-md shadow-cyan-400/20'
                        : 'border border-white/10 bg-white/5 text-slate-300 hover:bg-white/10'
                    }`}
                  >
                    {domain.title}
                    <span
                      className={`ml-1 rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
                        isActive ? 'bg-slate-950/20 text-slate-950' : 'bg-white/10 text-slate-400'
                      }`}
                    >
                      {domainSectionsCount}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Instant Search Bar */}
            <div className="relative w-full lg:w-80">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search operational modules..."
                className="w-full rounded-xl border border-white/10 bg-black/40 pl-9 pr-8 py-2 text-xs text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-cyan-400/50"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>
        </section>

        {/* Operational Domain Groups */}
        <div className="space-y-10">
          {groupedDomains.map((domain) => {
            if (domain.sections.length === 0 && searchQuery) {
              return null; // Hide domain heading if no matching sections found for search query
            }

            return (
              <section key={domain.id} className="scroll-mt-24">
                {/* Domain Header with Summary Badges */}
                <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-baseline sm:justify-between border-b border-white/10 pb-3">
                  <div>
                    <h2 className="text-xl font-extrabold tracking-tight text-white flex items-center gap-2">
                      {domain.title}
                    </h2>
                    <p className="mt-1 text-xs text-slate-400 max-w-2xl">{domain.description}</p>
                  </div>

                  {/* Domain Status Summary Badges */}
                  <div className="flex flex-wrap items-center gap-2 text-[11px] font-semibold shrink-0">
                    <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-slate-300">
                      {domain.totalCount} modules
                    </span>
                    <span className="rounded-full border border-emerald-400/20 bg-emerald-400/10 px-2.5 py-1 text-emerald-300">
                      {domain.completeCount} verified complete
                    </span>
                    {domain.nextCount > 0 && (
                      <span className="rounded-full border border-cyan-400/20 bg-cyan-400/10 px-2.5 py-1 text-cyan-200">
                        {domain.nextCount} active migration targets
                      </span>
                    )}
                  </div>
                </div>

                {/* Grid of Domain Cards */}
                {domain.sections.length > 0 ? (
                  <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-3">
                    {domain.sections.map((section) => {
                      const Icon = section.icon;
                      const card = (
                        <article className="group h-full flex flex-col justify-between rounded-2xl border border-white/10 bg-white/[0.025] p-5 transition duration-200 hover:-translate-y-0.5 hover:border-cyan-400/30 hover:bg-white/[0.04] hover:shadow-lg hover:shadow-black/40">
                          <div>
                            <div className="mb-4 flex items-start justify-between gap-3">
                              <div className="rounded-xl border border-white/10 bg-black/30 p-2.5 transition group-hover:border-cyan-400/30 group-hover:bg-cyan-400/10">
                                <Icon className="h-5 w-5 text-cyan-300" />
                              </div>
                              <StatusBadge status={section.status} />
                            </div>
                            <h3 className="text-base font-bold text-slate-100 group-hover:text-cyan-200 transition">
                              {section.title}
                            </h3>
                            <p className="mt-2 text-xs leading-5 text-slate-400">{section.description}</p>
                          </div>

                          <div className="mt-5 flex items-center justify-between border-t border-white/5 pt-3 text-[11px] font-semibold text-slate-500 group-hover:text-cyan-300 transition">
                            <span className="uppercase tracking-wider">
                              {section.status === 'complete'
                                ? 'Implemented & Verified'
                                : section.status === 'next'
                                ? 'Active Target'
                                : 'Planned'}
                            </span>
                            <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-1" />
                          </div>
                        </article>
                      );

                      const navigable = section.status === 'complete' || section.status === 'next';
                      return navigable ? (
                        <Link key={section.id} href={`/admin/${section.id}`} className="block h-full">
                          {card}
                        </Link>
                      ) : (
                        <div key={section.id} className="h-full">
                          {card}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="rounded-2xl border border-dashed border-white/10 p-6 text-center text-xs text-slate-500">
                    No modules match "{searchQuery}" in this domain.
                  </div>
                )}
              </section>
            );
          })}

          {filteredSections.length === 0 && (
            <div className="rounded-3xl border border-white/10 bg-white/[0.02] p-12 text-center">
              <Search className="mx-auto h-8 w-8 text-slate-600" />
              <h3 className="mt-4 text-base font-bold text-slate-300">No operational modules found</h3>
              <p className="mt-1 text-xs text-slate-500">
                No modules matched your search query "{searchQuery}". Try searching for terms like "model", "telemetry", "database", or "ingestion".
              </p>
              <button
                onClick={() => setSearchQuery('')}
                className="mt-4 inline-flex items-center gap-2 rounded-xl border border-cyan-400/20 bg-cyan-400/10 px-4 py-2 text-xs font-semibold text-cyan-200 hover:bg-cyan-400/20"
              >
                Clear Search Query
              </button>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
