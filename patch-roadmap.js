const fs = require('fs');
let code = fs.readFileSync('lib/admin-roadmap.ts', 'utf8');

const newRoute = `  { id: 'ai-trader-dynamics', domainId: 'observe-respond', title: 'AI Trader Dynamics', description: 'Algorithmic staking observability, active sequences, real-time drawdowns, and Circuit Breaker controls.', status: 'complete' },`;

if (!code.includes('ai-trader-dynamics')) {
  code = code.replace(
    "  { id: 'observability', domainId: 'observe-respond', title: 'Observability', description: 'Persisted telemetry, correlation IDs and event stream.', status: 'complete' },",
    "  { id: 'observability', domainId: 'observe-respond', title: 'Observability', description: 'Persisted telemetry, correlation IDs and event stream.', status: 'complete' },\n" + newRoute
  );
  fs.writeFileSync('lib/admin-roadmap.ts', code);
}
