const fs = require('fs');
let code = fs.readFileSync('lib/telegram-trade-controller.ts', 'utf8');

code = code.replace(
  "Please enter your custom stake amount in USD for *\\n${symbol}* (e.g. \\`15.50\\`):\\n\\n",
  "Please enter your custom stake amount in USD for *${symbol}* (e.g. \\`15.50\\`):\\n\\n"
);
fs.writeFileSync('lib/telegram-trade-controller.ts', code);
