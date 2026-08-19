'use client';

import dynamic from 'next/dynamic';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Footer } from '@/components/custom/footer';
import { Header } from '@/components/custom/header';
import { SymbolSelector } from '@/components/custom/symbol-selector';
import { ThemeToggle } from '@/components/custom/theme-toggle';
import { Skeleton } from '@/components/ui/skeleton';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { useContractMarkers } from '@/hooks/use-contract-markers';
import { useMemo, useState, useCallback, type CSSProperties } from 'react';
import { toast } from 'sonner';
import { Ban } from 'lucide-react';
import type { Tick } from '@deriv/core';
import { TradeControls } from './trade-controls';
import { ConfigurableTradeControls } from './configurable-trade-controls';
import { PayoutInfoCard } from '@/components/custom/payout-info-card';
import { TickSentimentBar } from '@/components/custom/tick-sentiment-bar';
import { ProModeControls } from '@/components/custom/pro-mode-controls';
import { AiTraderControls } from '@/components/custom/ai-trader-controls';
import { ModeNavBar } from '@/components/custom/mode-nav-bar';
import { PositionsDrawer } from '@/components/custom/positions-drawer';
import { useTickRecorder } from '@/hooks/use-tick-recorder';
import { useRealtimeSignals, type TradeSignal } from '@/hooks/use-realtime-signals';
import type { AutoHorizonMode } from '@/lib/duration-utils';
import type { AppTradingMode } from '@/components/custom/mode-selection-modal';
import type { RiseFallAppConfig } from '../lib/app-config';
import type { ClosedPosition } from '@/hooks/use-closed-positions';

/**
 * A zone overlaid on the chart region. Two modes:
 *  - not-editable (no onClick): ⛔ "… · not editable" hint on hover.
 *  - selectable (onClick): clickable to select; ring highlights when selected.
 * Either way it blocks direct chart interaction in edit mode.
 */
function FixedZone({
  label,
  style,
  onClick,
  selected,
}: {
  label: string;
  style: CSSProperties;
  onClick?: () => void;
  selected?: boolean;
}) {
  const selectable = !!onClick;
  return (
    <div
      className={`group/zone absolute left-0 right-0 z-[60] ${selectable ? 'cursor-pointer' : ''}`}
      style={style}
      onClick={onClick}
    >
      <div
        className={[
          'pointer-events-none absolute inset-0 rounded-md ring-2 ring-inset transition-opacity',
          selected
            ? 'opacity-100 ring-primary'
            : 'opacity-0 ring-muted-foreground/30 group-hover/zone:opacity-100',
        ].join(' ')}
      >
        <span className="absolute left-3 top-2 flex items-center gap-1.5 rounded-md bg-background/90 px-2 py-1 text-[11px] font-medium text-muted-foreground shadow-sm ring-1 ring-border">
          {!selectable && <Ban className="h-3.5 w-3.5" />}
          {selectable ? label : `${label} · not editable`}
        </span>
      </div>
    </div>
  );
}
import type {
  AuthState,
  DerivAccount,
  ActiveSymbol,
  ProposalInfo,
  BuyResult,
  DerivWS,
} from '@deriv/core';
import type { Direction, DurationSelectUnit, DurationOption } from '../lib/types';
import type { UseSmartChartsApiReturn } from '@/hooks/use-smartcharts-api';
import type { SmartChartChartData } from '@/hooks/use-smartchart-chart-data';
import type { OpenPosition } from '../lib/types';

const RiseFallChart = dynamic(() => import('./rise-fall-chart').then(module => module.RiseFallChart), {
  ssr: false,
  loading: () => (
    <div className="h-full w-full animate-pulse rounded-md border border-border/50 dark:border-white/[0.08] bg-muted/30" />
  ),
});

export interface RiseFallViewProps {
  // Auth
  authState: AuthState;
  accounts: DerivAccount[];
  activeAccount: DerivAccount | null;
  onLogin: () => Promise<void>;
  onSignUp: () => Promise<void>;
  onLogout: () => void;
  onSwitchAccount: (accountId: string) => Promise<void>;

  // Connection / loading
  ws: DerivWS | null;
  isConnected: boolean;
  isLoading: boolean;
  error: string | null;

  // Market data
  symbols: ActiveSymbol[];
  activeSymbol: ActiveSymbol | null;
  currentTick?: Tick | null;
  selectSymbol: (symbol: string) => void;
  /** Recent price window + pip size for the active symbol — powers the
   *  Symbol Selector's movement indicator when the chart is hidden. */
  prices?: number[];
  pipSize?: number;

  // Trade controls
  direction: Direction;
  setDirection: (direction: Direction) => void;
  allowEquals: boolean;
  setAllowEquals: (value: boolean) => void;
  stake: string;
  setStake: (value: string) => void;
  duration: number;
  setDuration: (value: number) => void;
  durationOptions: DurationOption[];
  durationUnit: DurationSelectUnit;
  setDurationUnit: (unit: DurationSelectUnit) => void;
  endDate: Date | undefined;
  setEndDate: (date: Date | undefined) => void;
  endTime: string;
  setEndTime: (time: string) => void;
  proposal: ProposalInfo | null;
  buyContract: (targetDir?: Direction) => Promise<void>;
  buyWithCustomParams?: (params: {
    direction: Direction;
    duration: number;
    durationUnit: DurationSelectUnit;
  }) => Promise<void>;
  isBuying: boolean;
  buyResult: BuyResult | null;
  buyError: string | null;
  clearBuyResult: () => void;

  // Positions
  openPositions: OpenPosition[];
  closedPositions?: ClosedPosition[];
  sellContract: (contractId: number, bidPrice: string) => Promise<void>;
  sellingId: number | null;
  sellError?: string | null;
  clearSellError?: () => void;

  // Chart data (elevated to page so preview can inject frozen mocks)
  chartData: SmartChartChartData | undefined;
  getQuotes: UseSmartChartsApiReturn['getQuotes'];
  subscribeQuotes: UseSmartChartsApiReturn['subscribeQuotes'];
  unsubscribeQuotes: UseSmartChartsApiReturn['unsubscribeQuotes'];
  /** Passed to SmartChart. Set to false for a frozen preview. Defaults to true. */
  isLive?: boolean;
  /**
   * Unix epoch (seconds) to freeze the chart at. When set, SmartCharts renders
   * a static historical snapshot and never sets up a live subscription.
   */
  endEpoch?: number;

  // Branding (used by preview route; no-op in the real app)
  logoSrc?: string;
  appName?: string;

  /**
   * No-code config. When provided, the trade controls render in configurable
   * styles/order (ConfigurableTradeControls). When omitted, the standard
   * TradeControls render unchanged.
   */
  appConfig?: RiseFallAppConfig;
  /** Edit mode — components become selectable (click opens their accordion). */
  editMode?: boolean;
  /** Called when an editable component is clicked (e.g. "chart", "stake"). */
  onSelect?: (key: string) => void;
  /** Currently selected component (highlighted). */
  selectedKey?: string | null;
  /** Rearrange mode — drag blocks in the phone to reorder the layout. */
  rearrangeMode?: boolean;
  /** Called with the new block order after a drag-drop reorder. */
  onReorder?: (order: RiseFallAppConfig['order']) => void;
  // Optimizer config & state
  isAutoDuration?: boolean;
  setIsAutoDuration?: (value: boolean) => void;
  autoHorizonMode?: AutoHorizonMode;
  setAutoHorizonMode?: (mode: AutoHorizonMode) => void;
  realtimeSignals?: ReturnType<typeof useRealtimeSignals>;
}

export function RiseFallView({
  authState,
  accounts,
  activeAccount,
  onLogin,
  onSignUp,
  onLogout,
  onSwitchAccount,
  ws,
  isConnected,
  isLoading,
  error,
  symbols,
  activeSymbol,
  currentTick = null,
  selectSymbol,
  prices = [],
  pipSize,
  direction,
  setDirection,
  allowEquals,
  setAllowEquals,
  stake,
  setStake,
  duration,
  setDuration,
  durationOptions,
  durationUnit,
  setDurationUnit,
  endDate,
  setEndDate,
  endTime,
  setEndTime,
  proposal,
  buyContract,
  buyWithCustomParams,
  isBuying,
  buyResult,
  buyError,
  clearBuyResult,
  openPositions,
  closedPositions = [],
  sellContract,
  sellingId,
  sellError = null,
  clearSellError = () => {},
  chartData,
  getQuotes,
  subscribeQuotes,
  unsubscribeQuotes,
  isLive,
  endEpoch,
  logoSrc,
  appName,
  appConfig,
  editMode,
  onSelect,
  selectedKey,
  rearrangeMode,
  onReorder,
  isAutoDuration = false,
  setIsAutoDuration = () => {},
  autoHorizonMode = 'auto',
  setAutoHorizonMode = () => {},
  realtimeSignals: propRealtimeSignals,
}: RiseFallViewProps) {
  const isMobile = useIsMobile();
  const [activeMode, setActiveMode] = useState<AppTradingMode>('pro');
  const [isPositionsOpen, setIsPositionsOpen] = useState(false);
  const chartHidden = appConfig?.chart?.hidden ?? false;
  const contractMarkers = useContractMarkers(openPositions, activeSymbol?.underlying_symbol, isMobile);

  // Automated Tick Recorder Service: Continuously record live WebSocket ticks to Neon PostgreSQL
  const currentPrice = prices && prices.length > 0 ? prices[prices.length - 1] : undefined;
  useTickRecorder(activeSymbol?.underlying_symbol, currentPrice ? { price: currentPrice } : null, ws);

  const currentTickObject = currentTick || (currentPrice ? ({ quote: currentPrice, epoch: Math.floor(Date.now() / 1000) } as Tick) : null);
  const localRealtimeSignals = useRealtimeSignals(activeSymbol, currentTickObject, prices, duration, durationUnit, autoHorizonMode, durationOptions, isAutoDuration);
  const realtimeSignals = propRealtimeSignals || localRealtimeSignals;

  const handleAutoFillTrade = useCallback((sig: TradeSignal) => {
    setDirection(sig.direction === 'RISE' ? 'CALL' : 'PUT');
    if (sig.recommendedDurationValue && sig.recommendedDurationUnit) {
      setDurationUnit(sig.recommendedDurationUnit);
      setDuration(sig.recommendedDurationValue);
    }
    toast.success('Trade Setup Auto-Filled', {
      description: `${sig.name}: ${sig.direction} (${sig.recommendedDurationLabel})`,
    });
  }, [setDirection, setDuration, setDurationUnit]);

  const handleQuickExecute = useCallback(async (sig: TradeSignal) => {
    const targetDir = sig.direction === 'RISE' ? 'CALL' : 'PUT';
    toast.info(`Executing ⚡ ${sig.name}`, {
      description: `Direction: ${sig.direction} | Duration: ${sig.recommendedDurationLabel}`,
    });

    if (buyWithCustomParams) {
      await buyWithCustomParams({
        direction: targetDir,
        duration: sig.recommendedDurationValue,
        durationUnit: sig.recommendedDurationUnit,
      });
    } else {
      await buyContract(targetDir);
    }
  }, [buyContract, buyWithCustomParams]);

  // In edit mode, login/sign-up/account actions are inert (no OAuth navigation
  // out of the editor) — only the theme toggle stays interactive.
  const headerEl = useMemo(() => {
    const noop = () => {};
    const noopAsync = async () => {};
    return (
      <Header
        authState={authState}
        accounts={accounts}
        activeAccount={activeAccount}
        onLogin={editMode ? noopAsync : onLogin}
        onSignUp={editMode ? noopAsync : onSignUp}
        onLogout={editMode ? noop : onLogout}
        onSwitchAccount={editMode ? noopAsync : onSwitchAccount}
        logoSrc={logoSrc}
        appName={appName}
        actions={<ThemeToggle />}
      />
    );
  }, [
    authState,
    accounts,
    activeAccount,
    editMode,
    onLogin,
    onSignUp,
    onLogout,
    onSwitchAccount,
    logoSrc,
    appName,
  ]);

  // The chart + symbol block. Used in the standard 2-column layout (left column)
  // and as a reorderable block in the no-code layout. When the chart is hidden,
  // the SmartChart is NOT mounted at all (so nothing bleeds through) and a
  // standalone Symbol Selector takes its place so users can still switch markets.
  const chartBlock = useMemo(
    () =>
      chartHidden ? (
        <div className="rf-chart-hidden relative">
          <div className={editMode ? 'pointer-events-none select-none' : ''}>
            <SymbolSelector
              symbols={symbols}
              activeSymbol={activeSymbol}
              onSymbolChange={selectSymbol}
              prices={prices}
              pipSize={pipSize}
            />
          </div>
          {editMode && !rearrangeMode && (
            <FixedZone label="Symbol picker" style={{ top: 0, bottom: 0 }} />
          )}
        </div>
      ) : (
        <div className="relative max-lg:h-[45dvh] lg:h-[min(33.6rem,66vh)] lg:min-h-[384px]">
          <div className={`h-full ${editMode ? 'pointer-events-none select-none' : ''}`}>
            {chartData ? (
              <RiseFallChart
                symbolKey="rise-fall-chart"
                symbol={activeSymbol?.underlying_symbol}
                isConnectionOpened={isConnected}
                isMobile={isMobile}
                chartData={chartData}
                getQuotes={getQuotes}
                subscribeQuotes={subscribeQuotes}
                unsubscribeQuotes={unsubscribeQuotes}
                onSymbolChange={selectSymbol}
                isLive={isLive}
                endEpoch={endEpoch}
                contractsArray={contractMarkers}
              />
            ) : (
              <Skeleton className="h-full w-full rounded-md" />
            )}
          </div>

          {editMode && !rearrangeMode && (
            <>
              <FixedZone label="Symbol picker" style={{ top: 0, height: 54 }} />
              <FixedZone label="Chart" style={{ top: 54, bottom: 0 }} />
            </>
          )}
        </div>
      ),
    [
      chartHidden,
      symbols,
      prices,
      pipSize,
      editMode,
      chartData,
      activeSymbol,
      isConnected,
      isMobile,
      getQuotes,
      subscribeQuotes,
      unsubscribeQuotes,
      selectSymbol,
      isLive,
      endEpoch,
      contractMarkers,
      rearrangeMode,
    ]
  );

  if (error) {
    return (
      <main className="flex flex-col bg-background items-center justify-center px-4 min-h-dvh">
        <Card className="max-w-md w-full">
          <CardHeader>
            <CardTitle className="text-destructive">Connection Error</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">{error}</p>
          </CardContent>
        </Card>
      </main>
    );
  }

  const renderConfigurable = (withChart: boolean) =>
    appConfig ? (
      <ConfigurableTradeControls
        config={appConfig}
        chartSlot={withChart ? chartBlock : undefined}
        direction={direction}
        onDirectionChange={setDirection}
        allowEquals={allowEquals}
        onAllowEqualsChange={setAllowEquals}
        isConnected={isConnected}
        stake={stake}
        onStakeChange={setStake}
        duration={duration}
        onDurationChange={setDuration}
        durationOptions={durationOptions}
        durationUnit={durationUnit}
        onDurationUnitChange={setDurationUnit}
        endDate={endDate}
        onEndDateChange={setEndDate}
        endTime={endTime}
        onEndTimeChange={setEndTime}
        ws={ws}
        activeSymbol={activeSymbol}
        proposal={proposal}
        onBuy={buyContract}
        isBuying={isBuying}
        buyResult={buyResult}
        buyError={buyError}
        onClearBuyResult={clearBuyResult}
        isAuthenticated={authState === 'authenticated'}
        authState={authState}
        onLogin={onLogin}
        onOpenPositions={() => setIsPositionsOpen(true)}
        editMode={editMode}
        onSelect={onSelect}
        selectedKey={selectedKey}
        rearrangeMode={rearrangeMode}
        onReorder={onReorder}
      />
    ) : (
      <div className="flex flex-col gap-3">
        {withChart && chartBlock}
        <TradeControls
          direction={direction}
          onDirectionChange={setDirection}
          allowEquals={allowEquals}
          onAllowEqualsChange={setAllowEquals}
          isConnected={isConnected}
          stake={stake}
          onStakeChange={setStake}
          duration={duration}
          onDurationChange={setDuration}
          durationOptions={durationOptions}
          durationUnit={durationUnit}
          onDurationUnitChange={setDurationUnit}
          endDate={endDate}
          onEndDateChange={setEndDate}
          endTime={endTime}
          onEndTimeChange={setEndTime}
          ws={ws}
          activeSymbol={activeSymbol}
          proposal={proposal}
          prices={prices}
          decisionSnapshot={realtimeSignals.decisionSnapshot}
          isAutoDuration={isAutoDuration}
          onIsAutoDurationChange={setIsAutoDuration}
          autoHorizonMode={autoHorizonMode}
          onAutoHorizonModeChange={setAutoHorizonMode}
          onBuy={buyContract}
          isBuying={isBuying}
          buyResult={buyResult}
          buyError={buyError}
          onClearBuyResult={clearBuyResult}
          isAuthenticated={authState === 'authenticated'}
          onLogin={onLogin}
          onOpenPositions={() => setIsPositionsOpen(true)}
        />
      </div>
    );

  const renderModeControls = (withChart: boolean) => {
    if (activeMode === 'pro') {
      return (
        <div className="flex flex-col gap-3">
          {withChart && chartBlock}
          <ProModeControls
            authState={authState}
            onLogin={onLogin}
            proposal={proposal}
            stake={stake}
            onStakeChange={setStake}
            direction={direction}
            onDirectionChange={setDirection}
            allowEquals={allowEquals}
            onAllowEqualsChange={setAllowEquals}
            onBuy={buyContract}
            isBuying={isBuying}
            isConnected={isConnected}
            duration={duration}
            onDurationChange={setDuration}
            durationUnit={durationUnit}
            onDurationUnitChange={setDurationUnit}
            durationOptions={durationOptions}
            endDate={endDate}
            onEndDateChange={setEndDate}
            endTime={endTime}
            onEndTimeChange={setEndTime}
            ws={ws}
            activeSymbol={activeSymbol}
            prices={prices}
            decisionSnapshot={realtimeSignals.decisionSnapshot}
            isAutoDuration={isAutoDuration}
            onIsAutoDurationChange={setIsAutoDuration}
            autoHorizonMode={autoHorizonMode}
            onAutoHorizonModeChange={setAutoHorizonMode}
          />
        </div>
      );
    }

    if (activeMode === 'ai') {
      return (
        <div className="flex flex-col gap-3">
          {withChart && chartBlock}
          <AiTraderControls
            authState={authState}
            onLogin={onLogin}
            proposal={proposal}
            stake={stake}
            onStakeChange={setStake}
            direction={direction}
            onDirectionChange={setDirection}
            allowEquals={allowEquals}
            onAllowEqualsChange={setAllowEquals}
            onBuy={buyContract}
            isBuying={isBuying}
            isConnected={isConnected}
            duration={duration}
            onDurationChange={setDuration}
            durationUnit={durationUnit}
            onDurationUnitChange={setDurationUnit}
            durationOptions={durationOptions}
            endDate={endDate}
            onEndDateChange={setEndDate}
            endTime={endTime}
            onEndTimeChange={setEndTime}
            ws={ws}
            activeSymbol={activeSymbol}
            prices={prices}
            decisionSnapshot={realtimeSignals.decisionSnapshot}
            isAutoDuration={isAutoDuration}
            onAutoDurationChange={setIsAutoDuration}
            autoHorizonMode={autoHorizonMode}
            onAutoHorizonModeChange={setAutoHorizonMode}
          />
        </div>
      );
    }

    return renderConfigurable(withChart);
  };

  return (
    <main
      className={`flex flex-col max-lg:h-dvh lg:overflow-visible ${
        editMode ? 'bg-muted/50' : 'bg-background'
      }`}
    >
      {editMode ? (
        // Edit mode: header is fixed and NOT editable. On hover, grey it out with
        // a "Not editable" hint. The overlay is pointer-events-none so the header
        // (incl. the dark/light theme toggle) stays clickable.
        <div className="group/hdr fixed left-0 right-0 top-0 z-50" style={{ height: 66 }}>
          {headerEl}
          {/* Hover hint: a ring + a LEFT-aligned chip so it never covers the
              right-side theme toggle (which stays usable). pointer-events-none
              so nothing here blocks clicks. */}
          <div className="pointer-events-none absolute inset-0 z-[60] opacity-0 ring-2 ring-inset ring-muted-foreground/25 transition-opacity group-hover/hdr:opacity-100">
            <span className="absolute left-3 top-1/2 flex -translate-y-1/2 items-center gap-1.5 rounded-md bg-background/90 px-2 py-1 text-[11px] font-medium text-muted-foreground shadow-sm ring-1 ring-border">
              <Ban className="h-3.5 w-3.5" />
              Not editable
            </span>
          </div>
        </div>
      ) : (
        headerEl
      )}
      {/* Spacer to push content below fixed header — taller when authenticated (account bar visible) */}
      <div className={authState === 'authenticated' ? 'h-[76px] shrink-0' : 'h-[66px] shrink-0'} />

      {appConfig ? (
        isMobile ? (
          /* No-code mobile layout: a single, reorderable column of blocks. The
             chart + symbol dropdown is one block (chartSlot); controls follow
             the configured order. */
          <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
            <div className="mx-auto flex w-full max-w-md flex-col gap-3 px-3 py-3 pb-28">
              {isLoading ? <Skeleton className="h-48 w-full rounded-xl" /> : renderModeControls(true)}
            </div>
          </div>
        ) : chartHidden ? (
          /* No-code desktop, chart OFF: a single centered column (symbol picker
             + controls stacked) at the controls' width — no wide empty chart
             column, and the height grows to fit its content (no inner scroll). */
          <div className="mx-auto flex w-full max-w-md flex-col gap-3 px-4 py-4 pb-28">
            {isLoading ? (
              <Skeleton className="h-96 w-full rounded-xl" />
            ) : (
              renderModeControls(true)
            )}
          </div>
        ) : (
          /* No-code desktop, chart ON: 2-column (chart left, controls card
             right). The card grows to its content height (no fixed height /
             inner scrollbar) — desktop has the vertical space. */
          <div className="flex w-full max-w-7xl mx-auto flex-col px-4 py-4 gap-3 pb-28">
            <div className="grid grid-cols-[1fr_400px] gap-4 items-start">
              <div className="flex flex-col gap-3">
                {chartBlock}
                <TickSentimentBar prices={prices} activeSymbol={activeSymbol} />
                <PayoutInfoCard proposal={proposal} stake={stake} />
              </div>
              {isLoading ? (
                <Skeleton className="h-[min(33.6rem,66vh)] min-h-[384px] w-full rounded-xl" />
              ) : (
                <Card className="min-h-[384px]">
                  <CardContent className="pt-4">{renderModeControls(false)}</CardContent>
                </Card>
              )}
            </div>
          </div>
        )
      ) : (
        /* Standard layout fallback */
        <div className="flex w-full max-w-7xl mx-auto flex-col px-3 py-2 gap-3 pb-28">
          <div className="grid grid-cols-[1fr_400px] gap-4">
            <div className="flex flex-col gap-3">
              {chartBlock}
              <TickSentimentBar prices={prices} activeSymbol={activeSymbol} />
              <PayoutInfoCard proposal={proposal} stake={stake} />
            </div>
            <Card>
              <CardContent className="pt-4">{renderModeControls(false)}</CardContent>
            </Card>
          </div>
        </div>
      )}

      {/* Mode Navigation Floating Bottom Dock */}
      <ModeNavBar
        activeMode={activeMode}
        onSelectMode={setActiveMode}
        activeSymbol={activeSymbol}
        onOpenPositions={() => setIsPositionsOpen(true)}
        activePositionsCount={openPositions.length}
        signals={realtimeSignals.signals}
        decisionSnapshot={realtimeSignals.decisionSnapshot}
        highConfidenceCount={realtimeSignals.highConfidenceCount}
        soundEnabled={realtimeSignals.soundEnabled}
        onToggleSound={realtimeSignals.toggleSound}
        winStats={realtimeSignals.winStats}
        onAutoFillTrade={handleAutoFillTrade}
        onQuickExecute={handleQuickExecute}
        isBuying={isBuying}
      />

      {/* In-App Positions & Reports Drawer */}
      <PositionsDrawer
        isOpen={isPositionsOpen}
        onClose={() => setIsPositionsOpen(false)}
        openPositions={openPositions}
        closedPositions={closedPositions}
        onSell={sellContract}
        sellingId={sellingId}
        sellError={sellError}
        onClearSellError={clearSellError}
      />

      {/* Fixed footer */}
      <div className="fixed bottom-0 left-0 right-0 py-2 text-center bg-background/80 backdrop-blur-sm">
        <Footer />
      </div>
    </main>
  );
}
