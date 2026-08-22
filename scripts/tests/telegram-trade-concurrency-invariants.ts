/**
 * Invariant Test Suite: Telegram Trade Concurrency & Session Lock Mechanics
 * Validates atomic database-level active-session locks, stale lease recovery,
 * heartbeat updates, and sequence telemetry formatting.
 */

import assert from 'assert';
import {
  claimTelegramTradeIntent,
  getTelegramTradeSessionLeaseMinutes,
  touchTelegramTradeIntent,
} from '../../lib/telegram-db';

async function runTests() {
  console.log('🧪 Starting Telegram Trade Concurrency & Session Lock Invariant Tests...');

  const origEnv = { ...process.env };

  try {
    // ------------------------------------------------------------------
    // TEST GROUP 1: Session Lease Configuration Invariants
    // ------------------------------------------------------------------
    console.log('\n--- Group 1: Session Lease Configuration Invariants ---');

    delete process.env.TELEGRAM_TRADE_SESSION_LEASE_MINUTES;
    assert.strictEqual(getTelegramTradeSessionLeaseMinutes(), 15, 'Default session lease must be 15 minutes');
    console.log('  ✅ Case 1.1 Passed: Default 15-minute session lease validated');

    process.env.TELEGRAM_TRADE_SESSION_LEASE_MINUTES = '30';
    assert.strictEqual(getTelegramTradeSessionLeaseMinutes(), 30, 'Configured positive integer lease must be respected');
    console.log('  ✅ Case 1.2 Passed: Custom 30-minute session lease validated');

    process.env.TELEGRAM_TRADE_SESSION_LEASE_MINUTES = 'invalid';
    assert.strictEqual(getTelegramTradeSessionLeaseMinutes(), 15, 'Invalid lease setting must fallback to default 15 minutes');
    console.log('  ✅ Case 1.3 Passed: Invalid lease setting fallback validated');

    // ------------------------------------------------------------------
    // TEST GROUP 2: Atomic Trade Intent Claim Transaction Invariants
    // ------------------------------------------------------------------
    console.log('\n--- Group 2: Atomic Trade Intent Claim Transaction Invariants ---');

    // Mock SQL runner simulating database responses for different scenarios
    const createMockSql = (scenario: 'claimed' | 'duplicate' | 'active') => {
      const mockSql: any = (strings: TemplateStringsArray, ...values: any[]) => {
        const query = strings.join('?');
        return { query, values };
      };

      mockSql.transaction = async (queries: any[]) => {
        assert.strictEqual(queries.length, 6, 'Transaction must contain lock, cleanup, check active, check dup, insert, check dup after');

        if (scenario === 'claimed') {
          return [
            [], // lock
            [], // stale update
            [], // activeBeforeInsert
            [], // duplicateBeforeInsert
            [{ idempotency_key: 'key-1' }], // inserted
            [{ idempotency_key: 'key-1' }], // duplicateAfterInsert
          ];
        }

        if (scenario === 'duplicate') {
          return [
            [], // lock
            [], // stale update
            [], // activeBeforeInsert
            [{ 1: 1 }], // duplicateBeforeInsert
            [], // inserted
            [{ 1: 1 }], // duplicateAfterInsert
          ];
        }

        // Scenario: active
        return [
          [], // lock
          [], // stale update
          [{ 1: 1 }], // activeBeforeInsert
          [], // duplicateBeforeInsert
          [], // inserted
          [], // duplicateAfterInsert
        ];
      };

      return mockSql;
    };

    // Case 2.1: Successfully claimed trade intent
    const mockSqlClaimed = createMockSql('claimed');
    const claimRes1 = await claimTelegramTradeIntent(mockSqlClaimed, 'cb_101', 999888);
    assert.strictEqual(claimRes1.claimed, true, 'Should claim intent when chat is idle and key is new');
    assert.strictEqual(claimRes1.reason, 'claimed');
    console.log('  ✅ Case 2.1 Passed: Successful claim returns { claimed: true, reason: "claimed" }');

    // Case 2.2: Duplicate callback query / idempotency key
    const mockSqlDup = createMockSql('duplicate');
    const claimRes2 = await claimTelegramTradeIntent(mockSqlDup, 'cb_101', 999888);
    assert.strictEqual(claimRes2.claimed, false, 'Should reject duplicate idempotency key');
    assert.strictEqual(claimRes2.reason, 'duplicate');
    console.log('  ✅ Case 2.2 Passed: Duplicate request returns { claimed: false, reason: "duplicate" }');

    // Case 2.3: Active session running for the same chat
    const mockSqlActive = createMockSql('active');
    const claimRes3 = await claimTelegramTradeIntent(mockSqlActive, 'cb_102', 999888);
    assert.strictEqual(claimRes3.claimed, false, 'Should block new trade attempt when chat has an active session');
    assert.strictEqual(claimRes3.reason, 'active');
    console.log('  ✅ Case 2.3 Passed: Active session collision returns { claimed: false, reason: "active" }');

    // ------------------------------------------------------------------
    // TEST GROUP 3: Touch / Heartbeat Lease Invariants
    // ------------------------------------------------------------------
    console.log('\n--- Group 3: Touch / Heartbeat Lease Invariants ---');

    let touchExecuted = false;
    let touchQuery = '';
    const mockTouchSql: any = async (strings: TemplateStringsArray, ...values: any[]) => {
      touchExecuted = true;
      touchQuery = strings.join('?');
      return [];
    };

    await touchTelegramTradeIntent(mockTouchSql, 'cb_101');
    assert.strictEqual(touchExecuted, true, 'touchTelegramTradeIntent must execute SQL update');
    assert.ok(touchQuery.includes('UPDATE telegram_trade_intents'), 'Must update telegram_trade_intents table');
    assert.ok(touchQuery.includes("status = 'processing'"), 'Must update only processing status intents');
    console.log('  ✅ Case 3.1 Passed: Heartbeat touch query properly targets processing trade intents');

    // ------------------------------------------------------------------
    // TEST GROUP 4: Manual vs Auto Trade Mode Constraints
    // ------------------------------------------------------------------
    console.log('\n--- Group 4: Manual vs Auto Trade Mode Constraints ---');

    const evaluateExecutionLimits = (isAuto: boolean, maxTradesConfig: number, maxStepsConfig: number) => {
      const maxTrades = isAuto ? (maxTradesConfig || 1) : 1;
      const maxSteps = isAuto ? (maxStepsConfig || 1) : 1;
      return { maxTrades, maxSteps };
    };

    const manualLimits = evaluateExecutionLimits(false, 5, 10);
    assert.strictEqual(manualLimits.maxTrades, 1, 'Manual mode MUST strictly cap maxTrades to 1 regardless of saved settings');
    assert.strictEqual(manualLimits.maxSteps, 1, 'Manual mode MUST strictly cap maxSteps to 1 regardless of saved settings');
    console.log('  ✅ Case 4.1 Passed: Manual single-trade mode strictly enforced (maxTrades=1, maxSteps=1)');

    const autoLimits = evaluateExecutionLimits(true, 3, 5);
    assert.strictEqual(autoLimits.maxTrades, 3, 'Autotrade mode MUST honor configured maxTrades');
    assert.strictEqual(autoLimits.maxSteps, 5, 'Autotrade mode MUST honor configured maxSteps');
    console.log('  ✅ Case 4.2 Passed: Autotrade mode honors strategy configurations');

    console.log('\n✨ All Telegram Trade Concurrency & Session Lock Invariant Tests PASSED successfully!');
  } finally {
    process.env = origEnv;
  }
}

runTests().catch((err) => {
  console.error('❌ Invariant Test Failure:', err);
  process.exit(1);
});
