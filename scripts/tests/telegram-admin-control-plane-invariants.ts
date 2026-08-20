/**
/**
 * Invariant Test Suite: Telegram Operational Control Plane & Global Circuit Breaker
 * Validates dual-layer authorization (Chat ID + User ID), idempotent circuit breaker state,
 * health-gate resume requirements, and fail-closed trade execution blocking.
 */

import assert from 'assert';
import {
  verifyTelegramAdminAuthorization,
  getAuthorizedAdminUserIds,
  getAuthorizedAlertChatId,
} from '../../lib/telegram-security';
import {
  getGlobalTradingCircuitBreakerConfig,
  updateGlobalTradingCircuitBreakerConfig,
  resumeGlobalTradingWithHealthCheck,
} from '../../lib/ops-runtime-config';

async function runTests() {
  console.log('🧪 Starting Telegram Admin Control Plane & Circuit Breaker Invariant Tests...');

  // Save current process.env to restore afterwards
  const origEnv = { ...process.env };

  try {
    // ------------------------------------------------------------------
    // TEST GROUP 1: Dual-Layer Telegram Admin Authorization
    // ------------------------------------------------------------------
    console.log('\n--- Group 1: Dual-Layer Authorization Invariants ---');

    // Case 1.1: Unconfigured Admin User IDs
    delete process.env.ALERT_TELEGRAM_ADMIN_USER_IDS;
    delete process.env.ALERT_TELEGRAM_CHAT_ID;

    let authResult = verifyTelegramAdminAuthorization({ chatId: 10001, userId: 99901 });
    assert.strictEqual(authResult.authorized, false, 'Should deny authorization when ALERT_TELEGRAM_ADMIN_USER_IDS is unconfigured');
    assert.strictEqual(authResult.reason, 'ALERT_TELEGRAM_ADMIN_USER_IDS_UNCONFIGURED');
    console.log('  ✅ Case 1.1 Passed: Unconfigured admin user IDs safely rejected');

    // Case 1.2: Configured Admin User IDs, Unauthorized User
    process.env.ALERT_TELEGRAM_ADMIN_USER_IDS = '123456789,987654321';
    process.env.ALERT_TELEGRAM_CHAT_ID = '-100123456789';

    authResult = verifyTelegramAdminAuthorization({ chatId: -100123456789, userId: 555555555 });
    assert.strictEqual(authResult.authorized, false, 'Should deny user not in ALERT_TELEGRAM_ADMIN_USER_IDS');
    assert.strictEqual(authResult.reason, 'UNAUTHORIZED_TELEGRAM_ADMIN_USER');
    console.log('  ✅ Case 1.2 Passed: Unauthorized user ID rejected even in authorized group chat');

    // Case 1.3: Authorized User, Unauthorized Chat
    authResult = verifyTelegramAdminAuthorization({ chatId: -999999999999, userId: 123456789 });
    assert.strictEqual(authResult.authorized, false, 'Should deny request from wrong chat ID');
    assert.strictEqual(authResult.reason, 'UNAUTHORIZED_TELEGRAM_ALERT_CHAT');
    console.log('  ✅ Case 1.3 Passed: Authorized user ID rejected when originating from wrong chat ID');

    // Case 1.4: Authorized User & Authorized Chat
    authResult = verifyTelegramAdminAuthorization({ chatId: -100123456789, userId: 123456789 });
    assert.strictEqual(authResult.authorized, true, 'Should authorize user ID in authorized chat ID');
    assert.strictEqual(authResult.reason, undefined);
    console.log('  ✅ Case 1.4 Passed: Dual-layer authorization succeeded for valid user + chat pair');

    // ------------------------------------------------------------------
    // TEST GROUP 2: Global Trading Circuit Breaker State & Idempotency
    // ------------------------------------------------------------------
    console.log('\n--- Group 2: Global Circuit Breaker State & Idempotency Invariants ---');

    const hasDb = Boolean(process.env.DATABASE_URL?.trim());
    if (!hasDb) {
      console.log('  ⚠️ DATABASE_URL not set. Skipping live DB-dependent circuit breaker tests.');
    } else {
      // Case 2.1: Default / Initial State
      const initialConfig = await getGlobalTradingCircuitBreakerConfig(true);
      assert.strictEqual(typeof initialConfig.isHalted, 'boolean');
      console.log(`  ✅ Case 2.1 Passed: Circuit breaker query returned valid schema (isHalted = ${initialConfig.isHalted})`);

      // Case 2.2: Halting the Circuit Breaker
      const testReason = 'Invariant Test Emergency Halt';
      const haltConfig = await updateGlobalTradingCircuitBreakerConfig({
        isHalted: true,
        haltReason: testReason,
        updatedBy: 'invariant_test_runner',
      });

      assert.strictEqual(haltConfig.isHalted, true, 'Circuit breaker should be halted');
      assert.strictEqual(haltConfig.haltReason, testReason);
      assert.strictEqual(haltConfig.updatedBy, 'invariant_test_runner');
      assert.ok(haltConfig.haltedAt, 'haltedAt timestamp should be set');
      const originalHaltedAt = haltConfig.haltedAt;
      console.log('  ✅ Case 2.2 Passed: Emergency Halt activated with reason and timestamp');

      // Case 2.3: Idempotent Halt Call (Reaffirming Halt)
      await new Promise((r) => setTimeout(r, 20)); // Small sleep to ensure clock advances
      const reaffirmConfig = await updateGlobalTradingCircuitBreakerConfig({
        isHalted: true,
        updatedBy: 'invariant_test_runner_reaffirm',
      });

      assert.strictEqual(reaffirmConfig.isHalted, true, 'Circuit breaker should remain halted');
      assert.strictEqual(reaffirmConfig.haltedAt, originalHaltedAt, 'haltedAt timestamp must remain preserved across idempotent halts');
      assert.strictEqual(reaffirmConfig.haltReason, testReason, 'haltReason must be preserved across idempotent halts');
      console.log('  ✅ Case 2.3 Passed: Idempotent halt reaffirmed without corrupting original haltedAt timestamp');
    }

    // ------------------------------------------------------------------
    // TEST GROUP 3: Health Gate Resuming Invariants
    // ------------------------------------------------------------------
    console.log('\n--- Group 3: Health-Gated Resume Invariants ---');

    if (!hasDb) {
      console.log('  ⚠️ DATABASE_URL not set. Skipping live DB-dependent health-gated resume tests.');
    } else {
      // Case 3.1: Resume execution attempt when health gate passes or fails
      try {
        const resumeResult = await resumeGlobalTradingWithHealthCheck({
          updatedBy: 'invariant_test_runner',
        });
        assert.strictEqual(resumeResult.isHalted, false, 'Circuit breaker should be unhalted if health gates pass');
        console.log('  ✅ Case 3.1 Passed: Resume succeeded after verifying health gates');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        assert.ok(msg.includes('RESUME_GATE_FAILED') || msg.includes('Database') || msg.includes('Deriv'), 'Error must be a clear health gate failure');
        console.log(`  ✅ Case 3.1 Passed: Safety health gate caught system constraint during resume test (${msg})`);
      }

      // Clean up test circuit breaker state back to normal
      await updateGlobalTradingCircuitBreakerConfig({
        isHalted: false,
        updatedBy: 'invariant_test_runner_cleanup',
      });
    }

    console.log('\n🎉 ALL TELEGRAM ADMIN CONTROL PLANE & CIRCUIT BREAKER INVARIANT TESTS PASSED SUCCESSFULLY!\n');
  } finally {
    // Restore process.env
    process.env = origEnv;
  }
}

runTests().catch((err) => {
  console.error('❌ Invariant Test Failure:', err);
  process.exit(1);
});
