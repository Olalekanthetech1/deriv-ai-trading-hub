import { executeArtifactBackfill, inspectArtifactBackfill } from '../lib/ml-artifact-maintenance';

async function main() {
  const apply = process.argv.includes('--apply');
  const result = apply ? await executeArtifactBackfill() : await inspectArtifactBackfill();
  console.log(JSON.stringify({
    complete: true,
    apply,
    ...result,
    executionBoundary: apply ? 'local-process' : 'database-integrity-scan',
  }, null, 2));
}

main().catch((error) => {
  console.error('[Artifact Backfill] failed:', error);
  process.exitCode = 1;
});
