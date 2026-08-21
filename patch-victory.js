const fs = require('fs');
let code = fs.readFileSync('lib/telegram-trade-controller.ts', 'utf8');

const target = `        const victoryStr = totalNetProfit > 0 
          ? \`🎉 *Profit!*\\nSession completed successfully\\n\`
          : totalNetProfit < 0 
            ? \`⚠️ *Loss!*\\nSession completed with a deficit\\n\`
            : \`ℹ️ *Session completed.*\\n\`;`;

const replacement = `        let victoryStr = '';
        if (balanceExpired) {
          victoryStr = \`🛑 *ACCOUNT BALANCE EXPIRED*\\nInsufficient funds for next multiplier.\\n\`;
        } else if (totalNetProfit > 0) {
          victoryStr = \`🎉 *Profit!*\\nSession completed successfully\\n\`;
        } else if (totalNetProfit < 0) {
          victoryStr = \`⚠️ *Loss!*\\nSession completed with a deficit\\n\`;
        } else {
          victoryStr = \`ℹ️ *Session completed.*\\n\`;
        }`;

code = code.replace(target, replacement);
fs.writeFileSync('lib/telegram-trade-controller.ts', code);
console.log("Patched victoryStr.");
