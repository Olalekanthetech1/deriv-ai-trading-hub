const fs = require('fs');
let code = fs.readFileSync('lib/telegram-trade-controller.ts', 'utf8');

const oldCode = `          await sql\`
            UPDATE telegram_trade_intents
            SET contract_id = \${buyRes.contract_id}, updated_at = NOW()
            WHERE idempotency_key = \${idempotencyKey}
          \`;

          const settlement = await client.waitForContractSettlement(buyRes.contract_id, 45000);`;

const newCode = `          await sql\`
            UPDATE telegram_trade_intents
            SET contract_id = \${buyRes.contract_id}, updated_at = NOW()
            WHERE idempotency_key = \${idempotencyKey}
          \`;

          let durationMs = 0;
          switch (selectedHorizon.unit) {
            case 't': durationMs = selectedHorizon.value * 2500; break; // ~2.5s per tick buffer
            case 's': durationMs = selectedHorizon.value * 1000; break;
            case 'm': durationMs = selectedHorizon.value * 60000; break;
            case 'h': durationMs = selectedHorizon.value * 3600000; break;
            case 'd': durationMs = selectedHorizon.value * 86400000; break;
          }
          const dynamicTimeoutMs = durationMs + 30000; // 30 second settlement buffer

          const settlement = await client.waitForContractSettlement(buyRes.contract_id, dynamicTimeoutMs);`;

if (code.includes(oldCode)) {
  fs.writeFileSync('lib/telegram-trade-controller.ts', code.replace(oldCode, newCode));
  console.log('Patched successfully!');
} else {
  console.log('Error: Could not find oldCode block to replace.');
}
