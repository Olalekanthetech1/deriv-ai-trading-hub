const fs = require('fs');
let code = fs.readFileSync('lib/market-ranking-cache.ts', 'utf8');

// 1. Add fetchDerivTickHistory import
if (!code.includes("import { fetchDerivTickHistory }")) {
  code = code.replace("import { getLiveRiseFallSymbols } from './rise-fall-symbols';", 
                      "import { getLiveRiseFallSymbols } from './rise-fall-symbols';\nimport { fetchDerivTickHistory } from './ticks-helper';");
}

// 2. Add medianCadenceMs to interface
if (!code.includes("medianCadenceMs?: number;")) {
  code = code.replace("featureSchemaVersion?: string;\n}", 
                      "featureSchemaVersion?: string;\n  medianCadenceMs?: number;\n}");
}

// 3. Update MAX_ALLOWED_DATA_AGE_MS and single-flight variables
code = code.replace("const MAX_ALLOWED_DATA_AGE_MS = 25000; // 25 seconds freshness gate",
                    "const MAX_ALLOWED_DATA_AGE_MS = 10000; // 10 seconds absolute ceiling");
code = code.replace("let isRefreshing = false;",
                    "let activeRefreshPromise: Promise<LiveMarketRankingSnapshot> | null = null;");

// 4. Update getValidMarketRankingSnapshot
const oldGetValid = `export async function getValidMarketRankingSnapshot(): Promise<LiveMarketRankingSnapshot | null> {
  const now = Date.now();

  // 1. Check in-memory snapshot
  if (inMemorySnapshot) {
    const age = now - new Date(inMemorySnapshot.generatedAt).getTime();
    if (
      inMemorySnapshot.validationStatus === 'VALIDATED' &&
      inMemorySnapshot.rankings.length > 0 &&
      age >= 0 &&
      age <= MAX_ALLOWED_DATA_AGE_MS
    ) {
      return {
        ...inMemorySnapshot,
        dataAgeMs: Math.round(age),
      };
    }
  }

  // 2. Check DB snapshot
  try {
    const sql = getDb();
    if (sql && (await initDbSchema())) {
      const rows = await sql\`
        SELECT metadata->\${CACHE_KEY} AS cached
        FROM market_assets
        WHERE symbol = 'GLOBAL_RANKINGS'
        LIMIT 1
      \`;

      const cached = rows?.[0]?.cached as LiveMarketRankingSnapshot | null | undefined;
      if (cached?.rankings?.length && cached.validationStatus === 'VALIDATED') {
        const age = now - new Date(cached.generatedAt).getTime();
        if (age >= 0 && age <= MAX_ALLOWED_DATA_AGE_MS) {
          inMemorySnapshot = cached;
          return {
            ...cached,
            dataAgeMs: Math.round(age),
          };
        }
      }
    }
  } catch (err) {
    console.warn('[MarketRankingCache] DB read error:', err instanceof Error ? err.message : 'unknown');
  }

  return null;
}`;

const newGetValid = `export async function getValidMarketRankingSnapshot(): Promise<LiveMarketRankingSnapshot | null> {
  const now = Date.now();
  
  const isValidAge = (snap: LiveMarketRankingSnapshot, currentAge: number) => {
     // Cadence-derived freshness: assume prediction holds for ~4 ticks
     const cadence = snap.medianCadenceMs || 2000; // default 2s
     const cadenceThreshold = Math.max(cadence * 4, 6000); // minimum 6s tolerance
     const effectiveFreshness = Math.min(MAX_ALLOWED_DATA_AGE_MS, cadenceThreshold);
     return currentAge >= 0 && currentAge <= effectiveFreshness;
  };

  // 1. Check in-memory snapshot
  if (inMemorySnapshot) {
    const age = now - new Date(inMemorySnapshot.generatedAt).getTime();
    if (
      inMemorySnapshot.validationStatus === 'VALIDATED' &&
      inMemorySnapshot.rankings.length > 0 &&
      isValidAge(inMemorySnapshot, age)
    ) {
      return {
        ...inMemorySnapshot,
        dataAgeMs: Math.round(age),
      };
    }
  }

  // 2. Check DB snapshot
  try {
    const sql = getDb();
    if (sql && (await initDbSchema())) {
      const rows = await sql\`
        SELECT metadata->\${CACHE_KEY} AS cached
        FROM market_assets
        WHERE symbol = 'GLOBAL_RANKINGS'
        LIMIT 1
      \`;

      const cached = rows?.[0]?.cached as LiveMarketRankingSnapshot | null | undefined;
      if (cached?.rankings?.length && cached.validationStatus === 'VALIDATED') {
        const age = now - new Date(cached.generatedAt).getTime();
        if (isValidAge(cached, age)) {
          inMemorySnapshot = cached;
          return {
            ...cached,
            dataAgeMs: Math.round(age),
          };
        }
      }
    }
  } catch (err) {
    console.warn('[MarketRankingCache] DB read error:', err instanceof Error ? err.message : 'unknown');
  }

  return null;
}`;

code = code.replace(oldGetValid, newGetValid);

// 5. Update refreshLiveMarketRankings
const oldRefresh = `export async function refreshLiveMarketRankings(
  onProgress?: (stage: 'data_stream' | 'ai_analysis' | 'target_locked') => Promise<void> | void
): Promise<LiveMarketRankingSnapshot> {
  if (isRefreshing && inMemorySnapshot) {
    return inMemorySnapshot;
  }

  isRefreshing = true;
  const startTime = Date.now();

  try {`;

const newRefresh = `export async function refreshLiveMarketRankings(
  onProgress?: (stage: 'data_stream' | 'ai_analysis' | 'target_locked') => Promise<void> | void
): Promise<LiveMarketRankingSnapshot> {
  // Single-flight request coalescing: concurrent misses join the active promise
  if (activeRefreshPromise) {
    return activeRefreshPromise;
  }

  activeRefreshPromise = (async () => {
    const startTime = Date.now();

    try {`;

code = code.replace(oldRefresh, newRefresh);

const oldSort = `    if (scanResults.length === 0) {
      throw new Error('MARKET_RANKINGS_INFERENCE_DEGRADED');
    }

    scanResults.sort((a, b) => b.winRate - a.winRate);

    if (onProgress) await onProgress('target_locked');

    const snapshot: LiveMarketRankingSnapshot = {
      generatedAt: new Date().toISOString(),
      tickTimestamp: Date.now(),
      candidateCount: scanResults.length,
      rankings: scanResults,
      dataAgeMs: Date.now() - startTime,
      validationStatus: 'VALIDATED',
      modelVersion: scanResults[0]?.modelVersion || 'v2-production',
      featureSchemaVersion: 'v2-microstructure',
    };`;

const newSort = `    if (scanResults.length === 0) {
      throw new Error('MARKET_RANKINGS_INFERENCE_DEGRADED');
    }

    scanResults.sort((a, b) => b.winRate - a.winRate);

    // Derive cadence from top asset
    let medianCadenceMs = 2000;
    try {
      if (scanResults.length > 0) {
        const topSymbol = scanResults[0].symbol;
        const ticks = await fetchDerivTickHistory(topSymbol, 15, 'latest', 1);
        if (ticks.length >= 5) {
          const sorted = ticks.slice().sort((a, b) => a.timestamp - b.timestamp);
          const intervals = sorted.slice(1).map((t, i) => t.timestamp - sorted[i].timestamp).filter(v => v > 0);
          if (intervals.length > 0) {
            intervals.sort((a, b) => a - b);
            medianCadenceMs = intervals[Math.floor(intervals.length / 2)];
          }
        }
      }
    } catch (err) {
      console.warn('[MarketRankingCache] Cadence discovery failed:', err instanceof Error ? err.message : 'unknown');
    }

    if (onProgress) await onProgress('target_locked');

    const snapshot: LiveMarketRankingSnapshot = {
      generatedAt: new Date().toISOString(),
      tickTimestamp: Date.now(),
      candidateCount: scanResults.length,
      rankings: scanResults,
      dataAgeMs: Date.now() - startTime,
      validationStatus: 'VALIDATED',
      modelVersion: scanResults[0]?.modelVersion || 'v2-production',
      featureSchemaVersion: 'v2-microstructure',
      medianCadenceMs,
    };`;

code = code.replace(oldSort, newSort);

const oldFinally = `    return snapshot;
  } finally {
    isRefreshing = false;
  }
}`;

const newFinally = `    return snapshot;
    } finally {
      activeRefreshPromise = null;
    }
  })();

  return activeRefreshPromise;
}`;

code = code.replace(oldFinally, newFinally);

fs.writeFileSync('lib/market-ranking-cache.ts', code);
console.log("Patched market-ranking-cache.ts");
