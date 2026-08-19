import { z } from 'zod';

export const PredictSchema = z.object({
  symbol: z.string().regex(/^[A-Za-z0-9_]+$/).max(50),
  ticks: z.array(z.object({ price: z.number().finite(), timestamp: z.number().int().positive().optional() })).optional().default([]),
  durationSecs: z.number().int().min(1).max(31_536_000),
  durationValue: z.number().int().min(1).max(365).optional(),
  durationUnit: z.enum(['t', 's', 'm', 'h', 'd']).optional(),
  assetCategory: z.number().int().min(0).max(3).optional(),
});

export const TrainSchema = z.object({
  symbol: z.string().regex(/^[A-Za-z0-9_]+$/).max(50).default('R_100'),
  category: z.string().optional(),
  retrainAll: z.boolean().optional().default(false),
  modelType: z.enum(['xgboost','lightgbm','catboost','tcn','lstm','transformer','hmm','isolation_forest','all']).default('xgboost'),
  durationSecs: z.number().int().min(1).max(3600).default(5),
  maxDepth: z.number().int().min(2).max(12).default(6),
  learningRate: z.number().min(0.0001).max(1).default(0.05),
  numEstimators: z.number().int().min(10).max(1000).default(100),
  subsample: z.number().min(0.5).max(1).default(0.8),
  epochs: z.number().int().min(1).max(100).default(8),
  batchSize: z.number().int().min(8).max(512).default(64),
});

export const BacktestSchema = z.object({
  symbol: z.string().regex(/^[A-Za-z0-9_]+$/).max(50),
  horizons: z.array(z.number().int().positive()).min(1),
  sampleLimit: z.number().int().positive().optional().default(500),
});
