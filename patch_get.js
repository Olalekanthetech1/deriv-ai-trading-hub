const fs = require('fs');
let code = fs.readFileSync('lib/market-ranking-cache.ts', 'utf8');

const oldFunc = `export async function getValidMarketRankingSnapshot(): Promise<LiveMarketRankingSnapshot | null> {
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

const newFunc = `export async function getValidMarketRankingSnapshot(): Promise<LiveMarketRankingSnapshot | null> {
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

if (!code.includes(oldFunc)) {
  console.log("Error: oldFunc not found!");
  process.exit(1);
}

code = code.replace(oldFunc, newFunc);
fs.writeFileSync('lib/market-ranking-cache.ts', code);
console.log("Patched successfully");
