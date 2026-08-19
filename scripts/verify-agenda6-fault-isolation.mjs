import fs from 'node:fs';

const file = 'lib/ml-training-orchestrator.ts';
const source = fs.readFileSync(file, 'utf8');

const required = [
  "let timeoutCount = 0;",
  "let modelTimedOut = false;",
  "status=${modelTimedOut ? 'timed_out' : 'failed'}",
  "if (modelTimedOut) timeoutCount += 1;",
  "const finalStatus = failed === 0 ? 'completed' : completed > 0 ? 'partial' : 'failed';",
  "jsonb_build_object('timeoutCount', ${timeoutCount})",
];

for (const marker of required) {
  if (!source.includes(marker)) {
    throw new Error(`Agenda 6 fault-isolation invariant missing: ${marker}`);
  }
}

if (source.includes("status='cancelled',error='Training run stopped after the native worker exceeded its configured timeout.'")) {
  throw new Error('Agenda 6 timeout path still cancels queued sibling models.');
}

console.log('[Agenda 6] Per-model fault-isolation invariants passed.');
