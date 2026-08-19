'use client';

import type { ProposalInfo } from '@deriv/core';

interface PayoutInfoCardProps {
  proposal: ProposalInfo | null;
  stake: string;
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function PayoutInfoCard({ proposal, stake }: PayoutInfoCardProps) {
  const numericStake = finiteNumber(stake) ?? 10;

  let payout = numericStake * 1.95;
  let profit = numericStake * 0.95;
  let returnPercent = 95;

  if (proposal) {
    const proposalPayout = finiteNumber(proposal.payout);
    const proposalAskPrice = finiteNumber(proposal.askPrice);

    if (proposalPayout !== null && proposalAskPrice !== null && proposalAskPrice > 0) {
      payout = proposalPayout;
      profit = proposalPayout - proposalAskPrice;
      returnPercent = (profit / proposalAskPrice) * 100;
    } else if (proposalPayout !== null) {
      payout = proposalPayout;
      profit = Math.max(0, proposalPayout - numericStake);
      returnPercent = numericStake > 0 ? (profit / numericStake) * 100 : 95;
    }
  }

  const safePayout = Number.isFinite(payout) ? payout : numericStake * 1.95;
  const safeProfit = Number.isFinite(profit) ? profit : numericStake * 0.95;
  const safeReturnPercent = Number.isFinite(returnPercent) ? returnPercent : 95;

  return (
    <div className="w-full rounded-2xl bg-[#0e131d]/90 border border-white/10 p-3.5 shadow-lg backdrop-blur-md flex items-center justify-between my-2">
      <div className="flex flex-col">
        <span className="text-[11px] font-medium text-gray-400 tracking-wide uppercase">Payout</span>
        <span className="text-lg font-bold text-white leading-tight">
          ${safePayout.toFixed(2)}
        </span>
      </div>

      <div className="px-3.5 py-1 rounded-full bg-emerald-950/80 border border-emerald-500/30 text-emerald-400 text-xs font-bold tracking-wider shadow-inner">
        +{safeReturnPercent.toFixed(0)}%
      </div>

      <div className="flex flex-col items-end">
        <span className="text-[11px] font-medium text-gray-400 tracking-wide uppercase">Profit</span>
        <span className="text-lg font-bold text-emerald-400 leading-tight">
          +${safeProfit.toFixed(2)}
        </span>
      </div>
    </div>
  );
}
