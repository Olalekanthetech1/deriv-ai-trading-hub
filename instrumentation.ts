export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { initializeMlPipelineConfig } = await import('./lib/ml-pipeline-config');
    await initializeMlPipelineConfig();
  }
}
