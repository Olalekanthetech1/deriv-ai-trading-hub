import { getMlRuntimeSchemaContract } from './ml-runtime-schema';
import { extractTickFeatures, featureObjToArray, type TickPoint } from './ml-feature-extractor';

export interface FeatureVectorContext { symbol: string; durationSecs: number; assetCategory: number; pipelineConfig?: import("./ml-pipeline-config").FeaturePipelineConfig; schemaContract?: import("./ml-runtime-schema").MlRuntimeSchemaContract; }
export interface TabularFeatureDataset { featureVectors: number[][]; labels: number[]; sampleCount: number; featureCount: number; schemaVersion: string; schemaFingerprint: string; }
export interface SequenceFeatureDataset { featureSequences: number[][][]; labels: number[]; sampleCount: number; featureCount: number; sequenceLength: number; schemaVersion: string; schemaFingerprint: string; }

function priceOf(tick: TickPoint): number {
  const price = Number(tick.price);
  if (!Number.isFinite(price)) throw new Error('INVALID_TICK_PRICE');
  return price;
}

function vectorForTicks(ticks: TickPoint[], context: FeatureVectorContext): number[] {
  return featureObjToArray(extractTickFeatures(ticks, {
    symbol: context.symbol,
    contractDurationSecs: context.durationSecs,
    assetCategoryNum: context.assetCategory,
    pipelineConfig: context.pipelineConfig,
  }));
}

export async function buildFeatureVector(ticks: TickPoint[], context: FeatureVectorContext): Promise<number[]> {
  const schema = context.schemaContract ?? (await getMlRuntimeSchemaContract());
  const vector = vectorForTicks(ticks, context);
  if (vector.length !== schema.featureCount) throw new Error(`FEATURE_VECTOR_LENGTH_MISMATCH: expected ${schema.featureCount}, got ${vector.length}`);
  return vector;
}

export async function buildFeatureSequence(ticks: TickPoint[], context: FeatureVectorContext): Promise<number[][]> {
  const schema = context.schemaContract ?? (await getMlRuntimeSchemaContract());
  const sequenceLength = schema.sequenceLength;
  if (ticks.length < sequenceLength) throw new Error(`INSUFFICIENT_SEQUENCE_TICKS: need ${sequenceLength}, got ${ticks.length}`);
  const sequence: number[][] = [];
  for (let i = ticks.length - sequenceLength + 1; i <= ticks.length; i += 1) {
    sequence.push(vectorForTicks(ticks.slice(0, i), context));
  }
  return sequence;
}

export async function buildTabularFeatureDataset(ticks: TickPoint[], context: FeatureVectorContext): Promise<TabularFeatureDataset> {
  const schema = context.schemaContract ?? (await getMlRuntimeSchemaContract());
  const canonicalWindow = schema.canonicalFeatureWindowTicks;
  const horizon = Math.max(1, Math.trunc(context.durationSecs));
  if (ticks.length <= canonicalWindow + horizon) throw new Error(`INSUFFICIENT_TICKS: need more than ${canonicalWindow + horizon} ticks`);
  const prices = ticks.map(priceOf);
  const featureVectors: number[][] = [];
  const labels: number[] = [];
  for (let i = canonicalWindow; i < prices.length - horizon; i += 1) {
    featureVectors.push(vectorForTicks(ticks.slice(0, i), context));
    labels.push(prices[i + horizon] > prices[i] ? 1 : 0);
  }
  if (new Set(labels).size < 2) throw new Error('TRAINING_LABELS_SINGLE_CLASS');
  return { featureVectors, labels, sampleCount: featureVectors.length, featureCount: schema.featureCount, schemaVersion: schema.featureSchemaVersion, schemaFingerprint: schema.schemaFingerprint };
}

export async function buildSequenceFeatureDataset(ticks: TickPoint[], context: FeatureVectorContext): Promise<SequenceFeatureDataset> {
  const schema = context.schemaContract ?? (await getMlRuntimeSchemaContract());
  const sequenceLength = schema.sequenceLength;
  const horizon = Math.max(1, Math.trunc(context.durationSecs));
  if (ticks.length <= sequenceLength + horizon) throw new Error(`INSUFFICIENT_TICKS: need more than ${sequenceLength + horizon} ticks`);
  const prices = ticks.map(priceOf);
  const featureSequences: number[][][] = [];
  const labels: number[] = [];
  for (let i = sequenceLength; i < prices.length - horizon; i += 1) {
    const sequence: number[][] = [];
    for (let j = i - sequenceLength + 1; j <= i; j += 1) sequence.push(vectorForTicks(ticks.slice(0, j), context));
    featureSequences.push(sequence);
    labels.push(prices[i + horizon] > prices[i] ? 1 : 0);
  }
  if (new Set(labels).size < 2) throw new Error('TRAINING_LABELS_SINGLE_CLASS');
  return { featureSequences, labels, sampleCount: featureSequences.length, featureCount: schema.featureCount, sequenceLength, schemaVersion: schema.featureSchemaVersion, schemaFingerprint: schema.schemaFingerprint };
}

export async function buildBacktestFeatureVectors(ticks: TickPoint[], horizon: number, context: FeatureVectorContext): Promise<number[][]> {
  const schema = context.schemaContract ?? (await getMlRuntimeSchemaContract());
  const canonicalWindow = schema.canonicalFeatureWindowTicks;
  if (ticks.length <= canonicalWindow + horizon) throw new Error(`INSUFFICIENT_TICKS: need more than ${canonicalWindow + horizon} ticks`);
  const vectors: number[][] = [];
  for (let i = canonicalWindow; i < ticks.length - horizon; i += 1) vectors.push(vectorForTicks(ticks.slice(0, i), context));
  return vectors;
}
