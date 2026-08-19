import { NextRequest, NextResponse } from 'next/server';
import { neon } from '@neondatabase/serverless';
import { getDbConnectionString } from '@/lib/db';
import { ensureTelegramSchema, encryptSecret } from '@/lib/telegram-db';
import { DerivAuthenticatedClient } from '@/lib/deriv-server-client';
import crypto from 'crypto';

function normalizeAccountType(value: unknown): 'demo' | 'real' {
  return String(value || 'demo').toLowerCase() === 'real' ? 'real' : 'demo';
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const accountId = typeof body?.account_id === 'string' ? body.account_id.trim() : '';
    const token = typeof body?.token === 'string' ? body.token.trim() : '';
    const requestedAccountType = normalizeAccountType(body?.account_type);

    if (!accountId || !token) {
      return NextResponse.json({ success: false, error: 'account_id and token are required' }, { status: 400 });
    }

    if (accountId.length > 64 || token.length < 10 || token.length > 4096) {
      return NextResponse.json({ success: false, error: 'Invalid account credentials' }, { status: 400 });
    }

    const dbUrl = getDbConnectionString();
    if (!dbUrl) {
      return NextResponse.json({ success: false, error: 'Database not configured' }, { status: 503 });
    }

    const sql = neon(dbUrl);
    await ensureTelegramSchema(sql);

    // Validate the credential with Deriv before persisting anything. Client-supplied
    // account type/currency/email are never treated as authoritative.
    const client = new DerivAuthenticatedClient(token);
    const accounts = await client.getAccountsList();
    const verifiedAccount = accounts.find((account) => account.account_id === accountId);
    if (!verifiedAccount) {
      client.close();
      return NextResponse.json({ success: false, error: 'The supplied Deriv token cannot access the requested account.' }, { status: 401 });
    }

    const verifiedType = normalizeAccountType(verifiedAccount.is_virtual === 1 ? 'demo' : 'real');
    if (verifiedType !== requestedAccountType) {
      client.close();
      return NextResponse.json({ success: false, error: 'Requested account type does not match the verified Deriv account.' }, { status: 400 });
    }

    const verifiedAuth = await client.connect(accountId);
    client.close();

    if (verifiedAuth.loginid !== accountId) {
      return NextResponse.json({ success: false, error: 'Deriv account authorization mismatch.' }, { status: 401 });
    }

    const pairingCode = crypto.randomBytes(16).toString('hex');
    const tokenEncrypted = encryptSecret(token);
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    await sql`
      INSERT INTO telegram_pairing_tokens (
        pairing_code,
        account_id,
        token_encrypted,
        account_type,
        currency,
        user_email,
        expires_at
      ) VALUES (
        ${pairingCode},
        ${verifiedAccount.account_id},
        ${tokenEncrypted},
        ${verifiedType},
        ${verifiedAccount.currency},
        ${null},
        ${expiresAt.toISOString()}
      )
    `;

    const botUsername = process.env.TELEGRAM_BOT_USERNAME || process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME;
    if (!botUsername) {
      return NextResponse.json({ success: false, error: 'TELEGRAM_BOT_USERNAME is not configured' }, { status: 503 });
    }

    const cleanBotUsername = botUsername.replace(/^@/, '');
    const deepLink = `https://t.me/${cleanBotUsername}?start=pair_${pairingCode}`;

    return NextResponse.json({
      success: true,
      pairing_code: pairingCode,
      deep_link: deepLink,
      bot_username: cleanBotUsername,
      expires_at: expiresAt.toISOString(),
      verified_account: {
        account_id: verifiedAccount.account_id,
        account_type: verifiedType,
        currency: verifiedAccount.currency,
        balance: verifiedAccount.balance,
      },
    });
  } catch (err) {
    console.error('[Telegram Pair API Error]:', err instanceof Error ? err.message : 'unknown');
    return NextResponse.json({ success: false, error: 'Unable to verify or create Telegram pairing session' }, { status: 503 });
  }
}
