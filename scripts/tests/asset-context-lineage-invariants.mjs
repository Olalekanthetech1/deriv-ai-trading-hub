import fs from 'node:fs';

const route = fs.readFileSync('app/api/signals/predict/route.ts', 'utf8');
const helper = fs.readFileSync('lib/authoritative-asset-context.ts', 'utf8');
const db = fs.readFileSync('lib/db.ts', 'utf8');
const telegram = fs.readFileSync('lib/telegram-trade-controller.ts', 'utf8');

if (!route.includes("resolveAuthoritativeAssetContext(symbol)")) throw new Error('Prediction route does not resolve authoritative asset context');
if (route.includes('body?.assetCategory') || route.includes('body.assetCategory')) throw new Error('Prediction route still trusts client-provided assetCategory');
if (!helper.includes('getLiveRiseFallSymbols(false, false)')) throw new Error('Asset context helper is not backed by live Deriv symbol discovery');
if (!helper.includes("case 'synthetic_index'")) throw new Error('Synthetic authoritative asset mapping is missing');
if (!db.includes('ALTER TABLE market_assets ADD COLUMN IF NOT EXISTS asset_class VARCHAR(32)')) throw new Error('asset_class schema migration is missing');
if (!db.includes('ALTER TABLE market_assets ADD COLUMN IF NOT EXISTS market_type VARCHAR(32)')) throw new Error('market_type schema migration is missing');
if (!telegram.includes('getLiveRiseFallSymbols(true, false)')) throw new Error('Telegram does not use authoritative symbol discovery');
if (telegram.includes('VALID_SYMBOLS')) throw new Error('Telegram still contains a static VALID_SYMBOLS universe');

console.log('asset-context-lineage-invariants: PASS');
