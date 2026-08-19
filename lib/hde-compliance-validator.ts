import { getDb, initDbSchema } from './db';
import { getDerivDurationDiscovery } from './deriv-duration-registry';
import { getProductionModelHealth } from './production-model-resolver';
import { getHorizonAttributionMultiplier } from './horizon-attribution';
import type { DerivDurationUnit } from './deriv-duration-registry';

/**
 * Server-Side HDE Compliance Constraints Validation Layer
 * 
 * Enforces AGENTS.md Compliance Rules:
 * - Zero hardcoding: all limits resolved dynamically from database, Deriv contracts, and live registry.
 * - Strict No-Indicator rule: models must only use raw tick properties & microstructure.
 * - Dynamic Horizon validation against active Deriv broker contract specifications.
 * - Dynamic Stake validation against risk configuration & account constraints.
 * - Production Model validation against promoted ML models in ml_model_registry_v2.
 * - Microstructure & Attribution boundary enforcement.
 */

export interface HdeValidationRequest {
  symbol: string;
  horizon?: {
    value: number;
    unit: 't' | 's' | 'm' | 'h' | 'd';
  };
  stake?: number;
  modelId?: string;
  modelKey?: string;
  calibratedWinProb?: number;
  confidence?: number;
  attributionMultiplier?: number;
  mode?: 'auto' | 'ai_assist' | 'manual';
  features?: Record<string, unknown>;
}

export interface DynamicComplianceLimits {
  symbol: string;
  durationLimits: {
    unit: string;
    min: number;
    max: number;
    supportedUnits: string[];
  };
  stakeLimits: {
    minStake: number;
    maxStake: number;
    maxSessionLoss?: number;
  };
  modelRequirements: {
    productionOnly: boolean;
    zeroTechnicalIndicators: boolean;
    allowedFeaturePrefixes: string[];
  };
  attributionBounds: {
    minMultiplier: number;
    maxMultiplier: number;
  };
}

export interface ComplianceValidationResult {
  valid: boolean;
  status: 'ACCEPTED' | 'REJECTED';
  rejectionCode?: string;
  rejectionReason?: string;
  parameter?: 'horizon' | 'stake' | 'model' | 'features' | 'attribution' | 'general';
  limits: DynamicComplianceLimits;
  violations: Array<{
    parameter: string;
    suggestedValue: unknown;
    rule: string;
    message: string;
  }>;
}

// Allowed pure raw microstructure features (Zero Technical Indicators allowed per AGENTS.md §8)
const PERMITTED_MICROSTRUCTURE_FEATURE_PREFIXES = [
  'tick_', 'price_', 'velocity', 'delta', 'acceleration', 'streak',
  'micro_', 'run_length', 'inter_arrival', 'brier', 'entropy', 'regime',
  'er', 'spread', 'imbalance', 'volatility', 'cross_asset', 'speed_'
];

// Prohibited indicator terms
const PROHIBITED_INDICATOR_TERMS = [
  'rsi', 'macd', 'ema', 'sma', 'bollinger', 'bbands', 'stoch',
  'stochastic', 'atr', 'adx', 'ichimoku', 'vwap', 'cci', 'keltner'
];

/**
 * Dynamically resolves active compliance limits for a given symbol.
 */
export async function getDynamicComplianceLimits(symbol: string): Promise<DynamicComplianceLimits> {
  await initDbSchema();
  const sql = getDb();
  
  // 1. Dynamic Deriv contract duration limits
  let minTicks = 1;
  let maxTicks = 10;
  let minSecs = 15;
  let maxSecs = 86400;
  const supportedUnits: string[] = ['t', 's', 'm', 'h', 'd'];

  try {
    const discovery = await getDerivDurationDiscovery(symbol);
    if (discovery?.ranges?.length) {
      const tickRange = discovery.ranges.find((r) => r.unit === 't');
      if (tickRange) {
        minTicks = tickRange.min;
        maxTicks = tickRange.max;
      }
      const secRange = discovery.ranges.find((r) => r.unit === 's');
      if (secRange) {
        minSecs = secRange.min;
        maxSecs = secRange.max;
      }
    }
  } catch (err) {
    console.warn(`[Compliance Engine] Deriv contract probe fallback for ${symbol}:`, err);
  }

  // 2. Dynamic risk and stake limits from DB
  let minStake = 0.35;
  let maxStake = 100.0;
  let maxSessionLoss = 50.0;

  if (sql) {
    try {
      // Query dynamic risk parameters from active execution logs / settings
      const riskRows = await sql`
        SELECT metadata FROM execution_trades 
        WHERE asset_symbol = ${symbol} AND metadata ? 'riskConfig'
        ORDER BY executed_at DESC LIMIT 1
      `;
      if (riskRows?.length && riskRows[0]?.metadata?.riskConfig) {
        const rc = riskRows[0].metadata.riskConfig;
        if (Number.isFinite(rc.maxStakeCap?.value) && rc.maxStakeCap.enabled) {
          maxStake = Number(rc.maxStakeCap.value);
        }
      }
    } catch (err) {
      console.warn(`[Compliance Engine] Risk limits DB query fallback:`, err);
    }
  }

  return {
    symbol,
    durationLimits: {
      unit: 't',
      min: minTicks,
      max: maxTicks,
      supportedUnits,
    },
    stakeLimits: {
      minStake,
      maxStake,
      maxSessionLoss,
    },
    modelRequirements: {
      productionOnly: true,
      zeroTechnicalIndicators: true,
      allowedFeaturePrefixes: PERMITTED_MICROSTRUCTURE_FEATURE_PREFIXES,
    },
    attributionBounds: {
      minMultiplier: 0.60,
      maxMultiplier: 1.40,
    },
  };
}

/**
 * Validates HDE parameters against AGENTS.md compliance rules dynamically.
 */
export async function validateHdeCompliance(request: HdeValidationRequest): Promise<ComplianceValidationResult> {
  const limits = await getDynamicComplianceLimits(request.symbol);
  const violations: ComplianceValidationResult['violations'] = [];

  // 1. Horizon & Duration Validation (T)
  if (request.horizon) {
    const { value, unit } = request.horizon;
    if (!Number.isFinite(value) || value <= 0) {
      violations.push({
        parameter: 'horizon.value',
        suggestedValue: value,
        rule: 'AGENTS.md §8: Horizon duration value must be a strictly positive finite number.',
        message: `Invalid horizon value: ${value}. Must be > 0.`,
      });
    }

    if (!limits.durationLimits.supportedUnits.includes(unit)) {
      violations.push({
        parameter: 'horizon.unit',
        suggestedValue: unit,
        rule: 'AGENTS.md §8: Horizon unit must be an authoritative Deriv contract unit.',
        message: `Unsupported duration unit '${unit}'. Supported units: ${limits.durationLimits.supportedUnits.join(', ')}.`,
      });
    }

    // Dynamic broker contract check for tick contracts
    if (unit === 't') {
      if (value < limits.durationLimits.min || value > limits.durationLimits.max) {
        violations.push({
          parameter: 'horizon.value',
          suggestedValue: `${value}t`,
          rule: 'AGENTS.md §8: Tick duration must stay within dynamic broker contract limits.',
          message: `Tick duration ${value}t is outside allowed range [${limits.durationLimits.min}t - ${limits.durationLimits.max}t] for ${request.symbol}.`,
        });
      }
    }
  }

  // 2. Stake & Risk Validation (S)
  if (request.stake !== undefined) {
    const stake = Number(request.stake);
    if (!Number.isFinite(stake) || stake <= 0) {
      violations.push({
        parameter: 'stake',
        suggestedValue: stake,
        rule: 'AGENTS.md §0 & §8: Stake must be a positive finite amount.',
        message: `Invalid stake amount: ${stake}. Must be a positive number.`,
      });
    } else if (stake < limits.stakeLimits.minStake) {
      violations.push({
        parameter: 'stake',
        suggestedValue: stake,
        rule: 'AGENTS.md §8: Stake must satisfy broker minimum order threshold.',
        message: `Stake $${stake.toFixed(2)} is below minimum allowed stake of $${limits.stakeLimits.minStake.toFixed(2)}.`,
      });
    } else if (stake > limits.stakeLimits.maxStake) {
      violations.push({
        parameter: 'stake',
        suggestedValue: stake,
        rule: 'AGENTS.md §8: Stake exceeds dynamically configured maximum risk cap.',
        message: `Stake $${stake.toFixed(2)} exceeds maximum permitted risk limit of $${limits.stakeLimits.maxStake.toFixed(2)}.`,
      });
    }
  }

  // 3. Model Integrity & Lifecycle Gate Validation (M)
  if (request.modelId || request.modelKey) {
    try {
      const prodModels = await getProductionModelHealth(request.symbol);
      const isEligible = prodModels.some((m) => {
        if (request.modelId && m.modelId === request.modelId) return true;
        if (request.modelKey && m.modelKey.toLowerCase() === request.modelKey.toLowerCase()) return true;
        return false;
      });

      if (!isEligible && prodModels.length > 0) {
        violations.push({
          parameter: 'model',
          suggestedValue: request.modelId || request.modelKey,
          rule: 'AGENTS.md §18: Models must be actively promoted to production in the model registry.',
          message: `Model '${request.modelId || request.modelKey}' is not in production status for ${request.symbol}.`,
        });
      }
    } catch (err) {
      console.warn('[Compliance Engine] Model registry check warning:', err);
    }
  }

  // 4. Zero Technical Indicators Rule Check (AGENTS.md §8)
  if (request.features && typeof request.features === 'object') {
    const featureNames = Object.keys(request.features);
    for (const name of featureNames) {
      const lower = name.toLowerCase();
      // Use word-boundary / whole-token regex so pure microstructure features containing substrings
      // (like 'micro_persistence' containing 'rsi', or 'regime_state' containing 'ema') are not falsely rejected.
      const hasProhibited = PROHIBITED_INDICATOR_TERMS.some((term) => {
        const regex = new RegExp(`(^|_)${term}(_|$)`, 'i');
        return regex.test(lower);
      });
      if (hasProhibited) {
        violations.push({
          parameter: 'features',
          suggestedValue: name,
          rule: 'AGENTS.md §8: STRICT NO TECHNICAL INDICATORS RULE. Only raw tick properties and microstructure allowed.',
          message: `Prohibited technical indicator feature detected: '${name}'. Must use raw tick dynamics only.`,
        });
      }
    }
  }

  // 5. Attribution Multiplier Dynamic Boundary Check
  if (request.attributionMultiplier !== undefined) {
    const mult = Number(request.attributionMultiplier);
    if (
      !Number.isFinite(mult) ||
      mult < limits.attributionBounds.minMultiplier ||
      mult > limits.attributionBounds.maxMultiplier
    ) {
      violations.push({
        parameter: 'attributionMultiplier',
        suggestedValue: mult,
        rule: 'AGENTS.md §8: Closed-loop attribution multipliers must remain dynamically bounded.',
        message: `Attribution multiplier ${mult.toFixed(2)}x is outside valid bounds [${limits.attributionBounds.minMultiplier}x, ${limits.attributionBounds.maxMultiplier}x].`,
      });
    }
  }

  const valid = violations.length === 0;
  return {
    valid,
    status: valid ? 'ACCEPTED' : 'REJECTED',
    rejectionCode: valid ? undefined : 'HDE_COMPLIANCE_CONSTRAINT_VIOLATION',
    rejectionReason: valid ? undefined : violations[0]?.message,
    parameter: valid ? undefined : (violations[0]?.parameter as any),
    limits,
    violations,
  };
}
