const fs = require('fs');
let code = fs.readFileSync('lib/telegram-trade-controller.ts', 'utf8');

const oldLimits = "    const maxTrades = user.max_trades || 1;\n" +
"    const maxSteps = user.max_steps || 1;\n" +
"    const scalingFactor = Number(user.scaling_factor) || 1.0;";

const newLimits = "    const isAuto = user.is_autotrading;\n" +
"    const maxTrades = isAuto ? (user.max_trades || 1) : 1;\n" +
"    const maxSteps = isAuto ? (user.max_steps || 1) : 1;\n" +
"    const scalingFactor = isAuto ? (Number(user.scaling_factor) || 1.0) : 1.0;";

if (code.includes(oldLimits)) {
  code = code.replace(oldLimits, newLimits);
  fs.writeFileSync('lib/telegram-trade-controller.ts', code);
  console.log('Successfully patched executeTrade limits');
} else {
  console.log('Error: Could not find oldLimits');
}
