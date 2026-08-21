const fs = require('fs');

const oldStr = `    if (!rankingSnapshot) {
      // Cache Miss or Expired -> Show dynamic progress stages while running Option 2 refresh pipeline
      const stage1Text =
        \`🤖 *AI IS ANALYZING THE MARKET*\\n\` +
        \`_Optimizing your next trades..._\\n\\n\` +
        \`📡 *TERMINAL:* Launching...\\n\` +
        \`📶 *Data stream:* Connecting...\\n\` +
        \`🤖 *AI analysis:* Initializing...\\n\` +
        \`⌛ *Next Signal:* Pending...\`;

      await this.safeSendApi('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: stage1Text,
        parse_mode: 'Markdown',
      });

      // Update Stage 2 status card
      const stage2Text =
        \`🤖 *AI IS ANALYZING THE MARKET*\\n\` +
        \`_Optimizing your next trades..._\\n\\n\` +
        \`📡 *TERMINAL:* Launched ✅\\n\` +
        \`📶 *Data stream:* Connected ✅\\n\` +
        \`🤖 *AI analysis:* Running 2-stage ensemble ranking...\\n\` +
        \`⌛ *Next Signal:* Pending...\`;

      await this.safeSendApi('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: stage2Text,
        parse_mode: 'Markdown',
      });

      try {
        rankingSnapshot = await refreshLiveMarketRankings();
      } catch (err) {
        console.warn('[Live Ranking Refresh Error]:', err instanceof Error ? err.message : 'unknown');
      }

      if (!rankingSnapshot || rankingSnapshot.rankings.length === 0) {`;

const newStr = `    if (!rankingSnapshot) {
      // Cache Miss or Expired -> Show dynamic progress stages while running Option 2 refresh pipeline
      const sendProgress = async (text: string) => {
        await this.safeSendApi('editMessageText', {
          chat_id: chatId,
          message_id: messageId,
          text: text,
          parse_mode: 'Markdown',
        }).catch(err => console.warn('[Telegram Edit Error]:', err instanceof Error ? err.message : 'unknown'));
      };

      const step1Text = 
        \`🤖 *AI IS ANALYZING THE MARKET*\\n\` +
        \`_Establishing secure connection..._\\n\\n\` +
        \`📡 TERMINAL: Connecting to broker... ⏳\`;
      
      await sendProgress(step1Text);

      try {
        rankingSnapshot = await refreshLiveMarketRankings(async (stage) => {
          if (stage === 'data_stream') {
            const step2Text = 
              \`🤖 *AI IS ANALYZING THE MARKET*\\n\` +
              \`_Ingesting live market data..._\\n\\n\` +
              \`📡 TERMINAL: Launched ✅\\n\` +
              \`📊 Data stream: Fetching live ticks... 🔄\`;
            await sendProgress(step2Text);
          } else if (stage === 'ai_analysis') {
            const step3Text = 
              \`🤖 *AI IS ANALYZING THE MARKET*\\n\` +
              \`_Evaluating market anomalies..._\\n\\n\` +
              \`📡 TERMINAL: Launched ✅\\n\` +
              \`📊 Data stream: Connected ✅\\n\` +
              \`🧠 AI analysis: Running multi-horizon ensemble... ⚙️\`;
            await sendProgress(step3Text);
          } else if (stage === 'target_locked') {
            const step4Text = 
              \`🤖 *AI IS ANALYZING THE MARKET*\\n\` +
              \`_Optimizing your next trades..._\\n\\n\` +
              \`📡 TERMINAL: Launched ✅\\n\` +
              \`📊 Data stream: Connected ✅\\n\` +
              \`🧠 AI analysis: Signals ranked ✅\\n\` +
              \`🎯 Target locked: Loading highest win rates... ⏳\`;
            await sendProgress(step4Text);
          }
        });
      } catch (err) {
        console.warn('[Live Ranking Refresh Error]:', err instanceof Error ? err.message : 'unknown');
      }

      if (!rankingSnapshot || rankingSnapshot.rankings.length === 0) {`;

let content = fs.readFileSync('lib/telegram-trade-controller.ts', 'utf8');
if (content.indexOf(oldStr) === -1) {
  console.log("OLD STRING NOT FOUND!");
  process.exit(1);
}
content = content.replace(oldStr, newStr);
fs.writeFileSync('lib/telegram-trade-controller.ts', content);
console.log("Patched telegram-trade-controller.ts successfully.");
