const fs = require('fs');
let code = fs.readFileSync('lib/telegram-trade-controller.ts', 'utf8');

// Replace the loop logic block:
const target1 = `          if (settlement.is_won) {
            break;
          } else {
            currentStake = currentStake * scalingFactor;
          }
        }
      }`;

const replacement1 = `          if (settlement.is_won) {
            break;
          } else {
            currentStake = currentStake * scalingFactor;
            if (step < maxSteps) {
              if (currentStake > Number(finalBalance.balance)) {
                balanceExpired = true;
                break;
              }
            }
          }
        }
        if (balanceExpired) break;
      }`;

// And we need to add `let balanceExpired = false;` right after `let anyTradeExecuted = false;`
const target2 = `    let finalBalance: any = null;
    let anyTradeExecuted = false;`;

const replacement2 = `    let finalBalance: any = null;
    let anyTradeExecuted = false;
    let balanceExpired = false;`;

// And replace the final send logic
const target3 = `        await this.safeSendApi('editMessageText', {
          chat_id: chatId,
          message_id: messageId,
          text: finalMessage,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🚀 New Trade', callback_data: 'menu_start_trade' }],
              [{ text: '🏠 Main Menu', callback_data: 'nav_main_menu' }],
            ],
          },
        });`;

const replacement3 = `        let photoAsset = null;
        if (balanceExpired) {
          photoAsset = TelegramAssets.balanceExpired;
        } else if (totalNetProfit > 0) {
          photoAsset = TelegramAssets.profit;
        } else if (totalNetProfit < 0) {
          photoAsset = TelegramAssets.lost;
        }

        let keyboard = {
          inline_keyboard: [
            [{ text: '🚀 New Trade', callback_data: 'menu_start_trade' }],
            [{ text: '🏠 Main Menu', callback_data: 'nav_main_menu' }],
          ],
        };
        
        if (balanceExpired) {
          keyboard = {
            inline_keyboard: [
              [{ text: '💰 Deposit', callback_data: 'menu_deposit' }],
              [{ text: '🏠 Main Menu', callback_data: 'nav_main_menu' }],
            ],
          };
        }

        await this.sendRichMessage(chatId, messageId, photoAsset, finalMessage, keyboard);`;

code = code.replace(target1, replacement1);
code = code.replace(target2, replacement2);
code = code.replace(target3, replacement3);

fs.writeFileSync('lib/telegram-trade-controller.ts', code);
console.log("Patched executeTrade.");
