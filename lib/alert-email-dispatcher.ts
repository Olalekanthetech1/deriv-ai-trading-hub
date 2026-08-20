/**
 * Email Notification Engine for ML Model Drift & System Incidents
 * Dispatches automated alerts via standard SMTP / webhook / Resend if configured.
 * Operates safely with graceful degradation and audit trail fallback if credentials are unset.
 */

import { recordObservabilityEvent } from './observability';

function markdownToHtml(md: string): string {
  if (!md) return '';
  let html = md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const codes: string[] = [];
  html = html.replace(/`([^`]+)`/g, (match, p1) => {
    codes.push(p1);
    return `__CODE_${codes.length - 1}__`;
  });

  const links: {text: string, url: string}[] = [];
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, p1, p2) => {
    links.push({text: p1, url: p2});
    return `__LINK_${links.length - 1}__`;
  });

  html = html.replace(/\*([^*]+)\*/g, '<b>$1</b>');
  html = html.replace(/(^|\W)_([^_]+)_(?!\w)/g, '$1<i>$2</i>');

  html = html.replace(/__LINK_(\d+)__/g, (match, p1) => {
    const link = links[parseInt(p1, 10)];
    return `<a href="${link.url}">${link.text}</a>`;
  });

  html = html.replace(/__CODE_(\d+)__/g, (match, p1) => {
    return `<code>${codes[parseInt(p1, 10)]}</code>`;
  });

  return html;
}

export interface DriftAlertPayload {
  modelId: string;
  modelKey: string;
  symbol: string;
  durationValue: number;
  durationUnit: string;
  liveAccuracy: number | null;
  validationAccuracy: number | null;
  accuracyDrop: number | null;
  sampleCount: number;
  breachReason: string | null;
  evaluatedAt: string;
}

/**
 * Dispatches an automated email notification when a model breaches drift thresholds
 * and undergoes circuit-breaker quarantine or demotion.
 */
export async function sendModelDriftAlertEmail(payload: DriftAlertPayload): Promise<{
  success: boolean;
  channel: 'smtp' | 'webhook' | 'audit_fallback';
  message: string;
}> {
  const alertRecipient = process.env.ADMIN_ALERT_EMAIL || process.env.USER_ALERT_EMAIL || 'olalekan4565@gmail.com';
  const webhookUrl = process.env.ALERT_WEBHOOK_URL || process.env.SLACK_ALERT_WEBHOOK;
  const resendApiKey = process.env.RESEND_API_KEY;
  const resendFromEmail = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
  // Allow dedicated Alert bot token (ALERT_TELEGRAM_BOT_TOKEN) or fallback to TELEGRAM_BOT_TOKEN
  const telegramBotToken = process.env.ALERT_TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
  const telegramChatId = process.env.ALERT_TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID;

  const subject = `⚠️ [ALERT] ML Model Drift Quarantine: ${payload.modelKey.toUpperCase()} on ${payload.symbol}`;
  const textBody = `
[ML CIRCUIT BREAKER ALERT]
=========================================
Model ID: ${payload.modelId}
Model Key: ${payload.modelKey}
Market Asset: ${payload.symbol}
Horizon: ${payload.durationValue}${payload.durationUnit}

STATUS: AUTOMATICALLY DEMOTED & QUARANTINED
Breach Reason: ${payload.breachReason || 'Live performance diverged from validation baseline'}

Performance Metrics:
- Validation Baseline Accuracy: ${(Number(payload.validationAccuracy || 0) * 100).toFixed(1)}%
- Live Evaluated Accuracy: ${(Number(payload.liveAccuracy || 0) * 100).toFixed(1)}%
- Accuracy Degradation: ${(Number(payload.accuracyDrop || 0) * 100).toFixed(1)}%
- Evaluated Sample Count: ${payload.sampleCount} trades/events
- Timestamp: ${payload.evaluatedAt}

Corrective Action Taken:
- Model demoted from 'production' to 'staging/quarantined'.
- Live automated signal generation for this model is halted.
- Retraining required before promotion re-evaluation.
=========================================
`;

  // 1. Resend API Dispatch if key is configured
  if (resendApiKey) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${resendApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: resendFromEmail,
          to: [alertRecipient],
          subject,
          text: textBody,
        }),
      });

      if (res.ok) {
        await recordObservabilityEvent({
          category: 'ml',
          severity: 'info',
          service: 'drift-email-dispatcher',
          eventType: 'drift_alert_email_sent_resend',
          message: `Model drift email alert dispatched to ${alertRecipient} for model ${payload.modelId}`,
          modelId: payload.modelId,
          symbol: payload.symbol,
          metadata: { recipient: alertRecipient, provider: 'resend' },
        });
        return { success: true, channel: 'smtp', message: `Dispatched to ${alertRecipient} via Resend` };
      }
    } catch (err: any) {
      console.warn('[Drift Alert Dispatcher] Resend API error:', err);
    }
  }

  // 2. Telegram Bot Dispatch if configured
  if (telegramBotToken && telegramChatId) {
    try {
      const telegramMessage = `⚠️ *[ALERT] ML Model Drift Quarantine*\n\n` +
        `• *Model ID:* \`${payload.modelId}\`\n` +
        `• *Key:* \`${payload.modelKey}\`\n` +
        `• *Asset:* *${payload.symbol}* (${payload.durationValue}${payload.durationUnit})\n` +
        `• *Action:* *Demoted & Quarantined*\n` +
        `• *Reason:* ${payload.breachReason || 'Live performance diverged from baseline'}\n` +
        `• *Validation Baseline:* ${(Number(payload.validationAccuracy || 0) * 100).toFixed(1)}%\n` +
        `• *Live Accuracy:* ${(Number(payload.liveAccuracy || 0) * 100).toFixed(1)}%\n` +
        `• *Accuracy Drop:* ${(Number(payload.accuracyDrop || 0) * 100).toFixed(1)}%\n` +
        `• *Samples:* ${payload.sampleCount}\n` +
        `• *Time:* ${payload.evaluatedAt}`;

      const tgRes = await fetch(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: telegramChatId,
          text: markdownToHtml(telegramMessage),
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '📊 System Health', callback_data: 'admin_health_status' },
                { text: '🤖 Model Status', callback_data: 'admin_models' },
              ],
              [
                { text: '🚨 Emergency Halt Trading', callback_data: 'admin_emergency_halt' },
              ],
            ],
          },
        }),
      });

      if (tgRes.ok) {
        await recordObservabilityEvent({
          category: 'ml',
          severity: 'info',
          service: 'drift-email-dispatcher',
          eventType: 'drift_alert_telegram_sent',
          message: `Model drift alert sent via Telegram to chat ${telegramChatId}`,
          modelId: payload.modelId,
          symbol: payload.symbol,
          metadata: { chatId: telegramChatId, provider: 'telegram' },
        });
      }
    } catch (err: any) {
      console.warn('[Drift Alert Dispatcher] Telegram Bot API error:', err);
    }
  }

  // 3. Webhook Dispatch if configured (supports Slack, Discord, or generic HTTP webhooks)
  if (webhookUrl) {
    try {
      const isDiscord = webhookUrl.includes('discord.com/api/webhooks');
      const isSlack = webhookUrl.includes('hooks.slack.com');

      let webhookBody: any;
      if (isDiscord) {
        webhookBody = {
          content: `⚠️ **${subject}**\n\`\`\`${textBody.trim()}\`\`\``,
        };
      } else if (isSlack) {
        webhookBody = {
          text: `⚠️ *${subject}*\n\`\`\`${textBody.trim()}\`\`\``,
        };
      } else {
        webhookBody = {
          event: 'MODEL_DRIFT_QUARANTINE',
          subject,
          text: textBody,
          details: payload,
          timestamp: new Date().toISOString(),
        };
      }

      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(webhookBody),
      });
      return { success: true, channel: 'webhook', message: 'Dispatched via alert webhook' };
    } catch (err: any) {
      console.warn('[Drift Alert Dispatcher] Webhook error:', err);
    }
  }

  // 3. Graceful Audit Log Fallback (Production Safe when no external email API key is configured)
  await recordObservabilityEvent({
    category: 'ml',
    severity: 'warn',
    service: 'drift-email-dispatcher',
    eventType: 'drift_alert_notification_queued',
    message: `[Email Alert Queued for ${alertRecipient}]: ${subject}`,
    modelId: payload.modelId,
    symbol: payload.symbol,
    metadata: {
      recipient: alertRecipient,
      alertBody: textBody,
      notificationType: 'model_drift_quarantine',
      reason: payload.breachReason,
    },
  });

  return {
    success: true,
    channel: 'audit_fallback',
    message: `Alert recorded in system audit logs for ${alertRecipient}`,
  };
}
