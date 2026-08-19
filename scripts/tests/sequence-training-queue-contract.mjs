import fs from 'node:fs';

const contract = fs.readFileSync('lib/ml-sequence-training-contract.ts', 'utf8');
const queue = fs.readFileSync('lib/ml-sequence-training-queue.ts', 'utf8');

if (!contract.includes('sourceType: "unified"') || !contract.includes('horizonKey: string')) {
  throw new Error('SEQUENCE_QUEUE_CONTRACT_FAILED: unified reference must require horizonKey');
}
if (!queue.includes('source_dataset_id') || !queue.includes('horizon_key')) {
  throw new Error('SEQUENCE_QUEUE_CONTRACT_FAILED: queue must persist canonical source and horizon');
}
console.log('sequence-training-queue-contract: PASS');
