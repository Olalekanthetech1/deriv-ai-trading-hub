export type StakingStrategy = 'Flat Staking' | 'Martingale' | 'Anti-Martingale' | 'D\'Alembert' | 'Oscar\'s Grind';

export interface StakingState {
  baseStake: number;
  currentStake: number;
  sequencePnL: number;
  sessionPnL: number;
  consecutiveLosses: number;
  consecutiveWins: number;
  sequenceTrades: number;
  sessionTrades: number;
  // Oscar's Grind specific
  sequenceTargetProfit: number;
}

export interface StakingDecision {
  strategy: string;
  proposedStake: number;
  cappedStake: number;
  riskLimitTriggered: boolean;
  action: 'PROCEED' | 'CAP_APPLIED' | 'HALT';
  reason?: string;
  nextState: StakingState;
}

export interface TradeOutcome {
  win: boolean;
  realizedPnL: number;
  payoutRatio: number; // e.g., 0.95 for 95% payout
}

export interface RiskConstraints {
  maxStake?: number;
  maxConsecutiveLosses?: number;
  maxSequenceLoss?: number;
  takeProfit?: number; // Target overall session profit ($) to auto-stop in profit
  stopLoss?: number;   // Overall session stop-loss limit ($) to auto-stop on loss
}

export function initializeStakingState(baseStake: number): StakingState {
  return {
    baseStake,
    currentStake: baseStake,
    sequencePnL: 0,
    sessionPnL: 0,
    consecutiveLosses: 0,
    consecutiveWins: 0,
    sequenceTrades: 0,
    sessionTrades: 0,
    sequenceTargetProfit: baseStake, // Target 1 base unit profit
  };
}

export function applyTradeOutcome(
  strategy: StakingStrategy,
  state: StakingState,
  outcome: TradeOutcome,
  riskConstraints: RiskConstraints
): StakingDecision {
  const newState = { ...state };
  
  newState.sequenceTrades += 1;
  newState.sessionTrades += 1;
  newState.sequencePnL += outcome.realizedPnL;
  newState.sessionPnL += outcome.realizedPnL;

  if (outcome.win) {
    newState.consecutiveWins += 1;
    newState.consecutiveLosses = 0;
  } else {
    newState.consecutiveLosses += 1;
    newState.consecutiveWins = 0;
  }

  let nextStake = newState.baseStake;

  switch (strategy) {
    case 'Flat Staking':
      nextStake = newState.baseStake;
      break;

    case 'Martingale':
      if (outcome.win) {
        // Reset on win
        nextStake = newState.baseStake;
        newState.sequencePnL = 0;
      } else {
        // Payout-aware Martingale: 
        // We want to recover all sequence losses + make baseStake profit.
        const requiredProfit = Math.abs(newState.sequencePnL) + newState.baseStake;
        nextStake = requiredProfit / (outcome.payoutRatio > 0 ? outcome.payoutRatio : 0.8);
      }
      break;

    case 'Anti-Martingale':
      if (outcome.win) {
        // Compound on win (Max 3 consecutive wins before reset to protect profits)
        if (newState.consecutiveWins >= 3) {
          nextStake = newState.baseStake;
          newState.sequencePnL = 0; // Lock in sequence
        } else {
          // Double up
          nextStake = newState.currentStake * 2;
        }
      } else {
        // Reset on loss
        nextStake = newState.baseStake;
        newState.sequencePnL = 0;
      }
      break;

    case 'D\'Alembert':
      if (outcome.win) {
        nextStake = newState.currentStake - newState.baseStake;
        if (nextStake < newState.baseStake) {
          nextStake = newState.baseStake;
          newState.sequencePnL = 0;
        }
      } else {
        nextStake = newState.currentStake + newState.baseStake;
      }
      break;

    case 'Oscar\'s Grind':
      if (newState.sequencePnL >= newState.sequenceTargetProfit) {
        // Sequence won, reset
        nextStake = newState.baseStake;
        newState.sequencePnL = 0;
      } else {
        if (outcome.win) {
          // Increase by 1 unit after a win
          let proposed = newState.currentStake + newState.baseStake;
          // Payout-aware cap: Don't risk more than needed to hit sequence target
          const neededProfit = newState.sequenceTargetProfit - newState.sequencePnL;
          const cappedStakeToHitTarget = neededProfit / (outcome.payoutRatio > 0 ? outcome.payoutRatio : 0.8);
          
          if (proposed * outcome.payoutRatio > neededProfit) {
             proposed = cappedStakeToHitTarget;
          }
          nextStake = Math.max(proposed, newState.baseStake);
        } else {
          // Stake remains the same after a loss
          nextStake = newState.currentStake;
        }
      }
      break;
  }

  // Risk Engine processing
  let action: StakingDecision['action'] = 'PROCEED';
  let reason = '';
  let finalStake = nextStake;

  // Floor to 2 decimals
  finalStake = Math.round(finalStake * 100) / 100;

  if (riskConstraints.takeProfit && riskConstraints.takeProfit > 0 && newState.sessionPnL >= riskConstraints.takeProfit) {
    action = 'HALT';
    reason = `Session Take-Profit target reached (+$${newState.sessionPnL.toFixed(2)}). Session locked in profit.`;
  } else if (riskConstraints.stopLoss && riskConstraints.stopLoss > 0 && newState.sessionPnL <= -Math.abs(riskConstraints.stopLoss)) {
    action = 'HALT';
    reason = `Session Stop-Loss limit triggered (-$${Math.abs(newState.sessionPnL).toFixed(2)}). Capital preservation circuit breaker active.`;
  } else if (riskConstraints.maxConsecutiveLosses && riskConstraints.maxConsecutiveLosses > 0 && newState.consecutiveLosses >= riskConstraints.maxConsecutiveLosses) {
    action = 'HALT';
    reason = `Max consecutive losses reached (${riskConstraints.maxConsecutiveLosses}). Session circuit breaker triggered.`;
  } else if (riskConstraints.maxSequenceLoss && riskConstraints.maxSequenceLoss > 0 && newState.sequencePnL <= -Math.abs(riskConstraints.maxSequenceLoss)) {
    action = 'HALT';
    reason = `Max sequence loss reached (-$${Math.abs(riskConstraints.maxSequenceLoss).toFixed(2)}). Sequence circuit breaker triggered.`;
  } else if (riskConstraints.maxStake && riskConstraints.maxStake > 0 && finalStake > riskConstraints.maxStake) {
    action = 'CAP_APPLIED';
    reason = `Proposed stake ($${finalStake.toFixed(2)}) exceeded max stake cap ($${riskConstraints.maxStake.toFixed(2)}). Stake capped to base stake ($${newState.baseStake.toFixed(2)}).`;
    finalStake = newState.baseStake;
    newState.sequencePnL = 0;
  }

  newState.currentStake = finalStake;

  return {
    strategy,
    proposedStake: Math.round(nextStake * 100) / 100,
    cappedStake: finalStake,
    riskLimitTriggered: action !== 'PROCEED',
    action,
    reason,
    nextState: newState,
  };
}
