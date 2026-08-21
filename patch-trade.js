const fs = require('fs');
let code = fs.readFileSync('lib/telegram-trade-controller.ts', 'utf8');

const oldCode = `    await this.safeSendApi('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: \`⚡ *Trade Processing*\\n\\\`$\${normalizedStake.toFixed(2)}\\\` on \\\`\${symbol}\\\`\\n\\nRefreshing the production AI signal and authoritative horizon...\`,
      parse_mode: 'Markdown',
    });

    const client = new DerivAuthenticatedClient(token);
    try {
      const signal = await this.requestLiveSignal(user, symbol);
      const contractType = signal.prediction.signal === 'CALL' ? 'CALL' : 'PUT';
      const selectedHorizon = signal.executionPlan.selectedHorizon;
      const targetAccountId = await this.resolveTargetAccountId(client, user, chatId);
      await client.connect(targetAccountId);

      const proposal = await client.getProposal({
        amount: normalizedStake,
        currency: user.currency,
        contract_type: contractType,
        duration: selectedHorizon.value,
        duration_unit: selectedHorizon.unit,
        symbol,
      });
      if (!proposal) throw new Error('DERIV_PROPOSAL_UNAVAILABLE');

      const buyRes = await client.buyContract(proposal.id, proposal.ask_price);
      if (!buyRes) throw new Error('DERIV_BUY_REJECTED');

      await sql\`
        UPDATE telegram_trade_intents
        SET contract_id = \${buyRes.contract_id}, updated_at = NOW()
        WHERE idempotency_key = \${idempotencyKey}
      \`;

      await this.safeSendApi('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text:
          \`⚡ *Live Trade Active*\\n\` +
          \`• *Asset:* \\\`\${symbol}\\\`\\n\` +
          \`• *Direction:* \\\`\${contractType}\\\`\\n\` +
          \`• *Stake:* \\\`$\${normalizedStake.toFixed(2)}\\\`\\n\` +
          \`• *Horizon:* \\\`\${selectedHorizon.label}\\\`\\n\` +
          \`• *Confidence:* \\\`\${signal.prediction.confidence.toFixed(1)}%\\\`\\n\` +
          \`• *Model:* \\\`\${signal.prediction.modelVersion}\\\`\\n\` +
          \`• *Contract:* \\\`#\${buyRes.contract_id}\\\`\\n\\n\` +
          \`_Waiting for broker settlement..._\`,
        parse_mode: 'Markdown',
      });

      const settlement = await client.waitForContractSettlement(buyRes.contract_id, 45000);
      const newBal = await client.getBalance();
      const profit = Number(settlement.profit || 0);
      const payout = Number(settlement.payout || 0);

      await sql\`
        INSERT INTO telegram_trade_logs (
          chat_id,
          contract_id,
          symbol,
          contract_type,
          stake,
          payout,
          profit,
          status,
          execution_plan_id,
          model_id,
          win_probability,
          raw_response
        ) VALUES (
          \${chatId},
          \${buyRes.contract_id},
          \${symbol},
          \${contractType},
          \${normalizedStake},
          \${payout},
          \${profit},
          \${settlement.is_won ? 'won' : settlement.is_settled ? 'lost' : 'timeout'},
          \${signal.executionPlan.executionPlanId},
          \${signal.prediction.modelVersion},
          \${signal.prediction.confidence / 100},
          \${JSON.stringify({ signal, settlement, buyRes })}
        )
      \`;

      await updateTelegramTradeIntent(sql, idempotencyKey, 'completed', buyRes.contract_id);

      const resultText = settlement.is_won
        ? \`🎉 *PROFIT*\\n\\n*Result:* *+$\${profit.toFixed(2)}*\\n💵 *Balance:* *$\${Number(newBal.balance).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} \${newBal.currency}*\`
        : settlement.is_settled
          ? \`🔴 *TRADE CLOSED*\\n\\n*Result:* *$\${profit.toFixed(2)}*\\n💵 *Balance:* *$\${Number(newBal.balance).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} \${newBal.currency}*\`
          : \`⚠️ *Settlement not confirmed within the monitoring window.*\\n\\n💵 *Latest Balance:* *$\${Number(newBal.balance).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} \${newBal.currency}*\`;

      await this.safeSendApi('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: \`\${resultText}\\n\\n🧾 *Execution Plan:* \\\`\${signal.executionPlan.executionPlanId}\\\`\`,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🚀 New Trade', callback_data: 'menu_start_trade' }],
            [{ text: '🏠 Main Menu', callback_data: 'nav_main_menu' }],
          ],
        },
      });

    } catch (err) {
      await updateTelegramTradeIntent(sql, idempotencyKey, 'failed');
      const rawError = err instanceof Error ? err.message : 'unknown';
      console.error('[Trade Execution Failed]:', rawError);

      const userMessage = formatBrokerExecutionError(err);
      await this.safeSendApi('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: \`❌ *Trade blocked*\\n\\n\\\`\${userMessage}\\\`\`,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[{ text: '🏠 Main Menu', callback_data: 'nav_main_menu' }]],
        },
      });
    } finally {
      client.close();
    }`;

const newCode = `    const maxTrades = user.max_trades || 1;
    const maxSteps = user.max_steps || 1;
    const scalingFactor = Number(user.scaling_factor) || 1.0;

    let sessionLedger = \`Trade session initialized...\\n\\n\`;
    let totalNetProfit = 0;
    let finalBalance = null;
    let anyTradeExecuted = false;

    await this.safeSendApi('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: sessionLedger,
      parse_mode: 'Markdown',
    });

    const client = new DerivAuthenticatedClient(token);
    try {
      const targetAccountId = await this.resolveTargetAccountId(client, user, chatId);
      await client.connect(targetAccountId);
      
      for (let tradeIdx = 1; tradeIdx <= maxTrades; tradeIdx++) {
        let currentStake = normalizedStake;
        
        for (let step = 1; step <= maxSteps; step++) {
          anyTradeExecuted = true;
          
          const pendingLine = \`⚡ Trade \${tradeIdx} | Step \${step} | \${currentStake.toFixed(2)} USD -> Pending...\`;
          await this.safeSendApi('editMessageText', {
            chat_id: chatId,
            message_id: messageId,
            text: sessionLedger + pendingLine,
            parse_mode: 'Markdown',
          });
          
          const signal = await this.requestLiveSignal(user, symbol);
          const contractType = signal.prediction.signal === 'CALL' ? 'CALL' : 'PUT';
          const selectedHorizon = signal.executionPlan.selectedHorizon;

          const proposal = await client.getProposal({
            amount: currentStake,
            currency: user.currency,
            contract_type: contractType,
            duration: selectedHorizon.value,
            duration_unit: selectedHorizon.unit,
            symbol,
          });
          if (!proposal) throw new Error('DERIV_PROPOSAL_UNAVAILABLE');

          const buyRes = await client.buyContract(proposal.id, proposal.ask_price);
          if (!buyRes) throw new Error('DERIV_BUY_REJECTED');

          await sql\`
            UPDATE telegram_trade_intents
            SET contract_id = \${buyRes.contract_id}, updated_at = NOW()
            WHERE idempotency_key = \${idempotencyKey}
          \`;

          const settlement = await client.waitForContractSettlement(buyRes.contract_id, 45000);
          finalBalance = await client.getBalance();
          const profit = Number(settlement.profit || 0);
          const payout = Number(settlement.payout || 0);

          totalNetProfit += profit;

          await sql\`
            INSERT INTO telegram_trade_logs (
              chat_id,
              contract_id,
              symbol,
              contract_type,
              stake,
              payout,
              profit,
              status,
              execution_plan_id,
              model_id,
              win_probability,
              raw_response
            ) VALUES (
              \${chatId},
              \${buyRes.contract_id},
              \${symbol},
              \${contractType},
              \${currentStake},
              \${payout},
              \${profit},
              \${settlement.is_won ? 'won' : settlement.is_settled ? 'lost' : 'timeout'},
              \${signal.executionPlan.executionPlanId},
              \${signal.prediction.modelVersion},
              \${signal.prediction.confidence / 100},
              \${JSON.stringify({ signal, settlement, buyRes })}
            )
          \`;

          const icon = settlement.is_won ? '🟢' : settlement.is_settled ? '🔴' : '⚠️';
          const resultStr = settlement.is_won ? \`+\${profit.toFixed(2)} USD\` : \`\${profit.toFixed(2)} USD\`;
          sessionLedger += \`\${icon} Trade \${tradeIdx} | Step \${step} | \${currentStake.toFixed(2)} USD -> \${resultStr}\\n\`;
          
          if (settlement.is_won) {
            break;
          } else {
            currentStake = currentStake * scalingFactor;
          }
        }
      }

      await updateTelegramTradeIntent(sql, idempotencyKey, 'completed');

      if (anyTradeExecuted && finalBalance) {
        const victoryStr = totalNetProfit > 0 
          ? \`🎉 *Profit!*\\nSession completed successfully\\n\`
          : totalNetProfit < 0
            ? \`⚠️ *Loss!*\\nSession completed with a deficit\\n\`
            : \`ℹ️ *Session completed.*\\n\`;
            
        const finalMessage = 
          \`\${sessionLedger}\\n\` +
          \`\${victoryStr}\` +
          \`Result: \${totalNetProfit >= 0 ? '' : ''}\${totalNetProfit.toFixed(2)} USD\\n\` +
          \`Balance: \${Number(finalBalance.balance).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} \${finalBalance.currency}\\n\\n\` +
          \`Choose your next step...\`;

        await this.safeSendApi('editMessageText', {
          chat_id: chatId,
          message_id: messageId,
          text: finalMessage,
          reply_markup: {
            inline_keyboard: [
              [{ text: '🚀 New Trade', callback_data: 'menu_start_trade' }],
              [{ text: '🏠 Main Menu', callback_data: 'nav_main_menu' }],
            ],
          },
        });
      }

    } catch (err) {
      await updateTelegramTradeIntent(sql, idempotencyKey, 'failed');
      const rawError = err instanceof Error ? err.message : 'unknown';
      console.error('[Trade Execution Failed]:', rawError);

      const userMessage = formatBrokerExecutionError(err);
      const partialLedger = sessionLedger ? \`\${sessionLedger}\\n\` : '';
      
      await this.safeSendApi('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: \`\${partialLedger}❌ *Trade Blocked / Aborted*\\n\\n\\\`\${userMessage}\\\`\`,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[{ text: '🏠 Main Menu', callback_data: 'nav_main_menu' }]],
        },
      });
    } finally {
      client.close();
    }`;

if (code.includes(oldCode)) {
  fs.writeFileSync('lib/telegram-trade-controller.ts', code.replace(oldCode, newCode));
  console.log('Patched successfully!');
} else {
  console.log('Error: Could not find exact old block to replace.');
}
