const fs = require('fs');
let code = fs.readFileSync('lib/telegram-trade-controller.ts', 'utf8');

const oldCodeStart = `    const client = new DerivAuthenticatedClient(token);
    try {
      const signal = await this.requestLiveSignal(user, symbol);
      const contractType = signal.prediction.signal === 'CALL' ? 'CALL' : 'PUT';
      const selectedHorizon = signal.executionPlan.selectedHorizon;
      const targetAccountId = await this.resolveTargetAccountId(client, user, chatId);
      await client.connect(targetAccountId);`;

if (!code.includes(oldCodeStart)) {
  console.log("Could not find oldCodeStart");
} else {
  console.log("Found oldCodeStart!");
}
