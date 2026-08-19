import fs from 'node:fs';

const source = fs.readFileSync('lib/ml-sequence-training-queue.ts', 'utf8');

const required = [
  'source_dataset_id UUID NOT NULL',
  'horizon_key VARCHAR(128)',
  'uq_ml_sequence_queue_active_unified_horizon',
  "source_type = 'unified'",
  'parseSequenceTrainingDatasetRef',
  'UNIFIED_SEQUENCE_REQUIRES_HORIZON',
];

for (const token of required) {
  if (!source.includes(token)) {
    throw new Error(`SEQUENCE_TRAINING_QUEUE_INVARIANT_FAILED: missing ${token}`);
  }
}

if (source.includes('dataset_id) WHERE status IN (\'queued\',\'running\')')) {
  throw new Error('SEQUENCE_TRAINING_QUEUE_INVARIANT_FAILED: legacy single-dataset uniqueness must not govern unified horizons');
}

console.log('sequence-training-queue-invariants: PASS');
