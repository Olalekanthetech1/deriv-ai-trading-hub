import { NextRequest, NextResponse } from 'next/server';
import { verifySessionToken } from '@/app/api/admin/auth/route';
import {
  getWorkerSwitchboardState,
  updateWorkerConfigKey,
  executeEmergencyHaltAll,
  releaseEmergencyHalt,
  type MasterAutomationMode,
} from '@/lib/worker-control-store';
import { updateQueueWorkerRuntimeConfig } from '@/lib/ops-runtime-config';

function noStore() {
  return { 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0' };
}

function isAuthenticated(req: NextRequest): boolean {
  const secret = process.env.ADMIN_SECRET_KEY?.trim();
  if (!secret) return true;
  const cookieToken = req.cookies.get('admin_session_token')?.value;
  const headerToken = req.headers.get('x-admin-token') || req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  return verifySessionToken(cookieToken) || verifySessionToken(headerToken);
}

export async function GET(req: NextRequest) {
  if (!isAuthenticated(req)) return NextResponse.json({ error: 'Unauthorized admin access.' }, { status: 401, headers: noStore() });
  try {
    const state = await getWorkerSwitchboardState();
    return NextResponse.json({ success: true, state }, { headers: noStore() });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unable to fetch worker switchboard state.' },
      { status: 500, headers: noStore() }
    );
  }
}

export async function POST(req: NextRequest) {
  if (!isAuthenticated(req)) return NextResponse.json({ error: 'Unauthorized admin access.' }, { status: 401, headers: noStore() });
  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body?.action || '').trim();

    if (action === 'set_master_mode') {
      const mode = (body.mode === 'autonomous' ? 'autonomous' : 'manual') as MasterAutomationMode;
      await releaseEmergencyHalt(mode, 'admin_ui');
      const newState = await getWorkerSwitchboardState();
      return NextResponse.json(
        { success: true, message: `Master automation mode changed to ${mode.toUpperCase()}.`, state: newState },
        { headers: noStore() }
      );
    }

    if (action === 'update_dataset_worker') {
      const enabled = Boolean(body.enabled);
      const maxConcurrentJobs = Math.max(1, Math.min(8, Number(body.maxConcurrentJobs || 2)));
      const autoResumeOnLoad = Boolean(body.autoResumeOnLoad);
      await updateWorkerConfigKey('dataset_builder_worker', { enabled, maxConcurrentJobs, autoResumeOnLoad }, 'admin_ui');
      const newState = await getWorkerSwitchboardState();
      return NextResponse.json(
        { success: true, message: `Dataset Builder worker configuration updated.`, state: newState },
        { headers: noStore() }
      );
    }

    if (action === 'update_training_queue') {
      const isPaused = Boolean(body.isPaused);
      const concurrencyLimit = Number(body.concurrencyLimit);
      const pauseReason = body.pauseReason ? String(body.pauseReason).trim() : null;
      await updateQueueWorkerRuntimeConfig({
        isPaused,
        concurrencyLimit: Number.isSafeInteger(concurrencyLimit) ? concurrencyLimit : undefined,
        pauseReason,
        updatedBy: 'admin_ui',
      });
      const newState = await getWorkerSwitchboardState();
      return NextResponse.json(
        { success: true, message: `Training Queue worker configuration updated.`, state: newState },
        { headers: noStore() }
      );
    }

    if (action === 'update_retraining_automation') {
      const enabled = Boolean(body.enabled);
      const intervalHours = Math.max(1, Math.min(168, Number(body.intervalHours || 24)));
      const minAccuracyThreshold = Math.max(0.1, Math.min(1.0, Number(body.minAccuracyThreshold || 0.55)));
      await updateWorkerConfigKey('retraining_automation', { enabled, intervalHours, minAccuracyThreshold }, 'admin_ui');
      const newState = await getWorkerSwitchboardState();
      return NextResponse.json(
        { success: true, message: `Auto-retraining worker configuration updated.`, state: newState },
        { headers: noStore() }
      );
    }

    if (action === 'update_circuit_breaker') {
      const enabled = Boolean(body.enabled);
      const autoDemote = Boolean(body.autoDemote);
      const driftToleranceRatio = Math.max(0.1, Math.min(0.9, Number(body.driftToleranceRatio || 0.48)));
      await updateWorkerConfigKey('circuit_breaker_evaluator', { enabled, autoDemote, driftToleranceRatio }, 'admin_ui');
      const newState = await getWorkerSwitchboardState();
      return NextResponse.json(
        { success: true, message: `Circuit breaker evaluator configuration updated.`, state: newState },
        { headers: noStore() }
      );
    }

    if (action === 'update_tick_ingestion') {
      const enabled = Boolean(body.enabled);
      const maxActiveSymbols = Math.max(1, Math.min(100, Number(body.maxActiveSymbols || 30)));
      await updateWorkerConfigKey('tick_ingestion_stream', { enabled, maxActiveSymbols }, 'admin_ui');
      const newState = await getWorkerSwitchboardState();
      return NextResponse.json(
        { success: true, message: `Tick ingestion stream configuration updated.`, state: newState },
        { headers: noStore() }
      );
    }

    if (action === 'emergency_halt_all') {
      const result = await executeEmergencyHaltAll('admin_ui');
      const newState = await getWorkerSwitchboardState();
      return NextResponse.json(
        {
          success: true,
          message: `EMERGENCY HALT EXECUTED: ${result.cancelledDatasetJobs} dataset jobs & ${result.cancelledTrainingRuns} training runs stopped. System is locked in MANUAL STANDBY.`,
          result,
          state: newState,
        },
        { headers: noStore() }
      );
    }

    return NextResponse.json({ success: false, error: 'Invalid worker control action.' }, { status: 400, headers: noStore() });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unable to execute worker control action.' },
      { status: 500, headers: noStore() }
    );
  }
}

export async function DELETE(req: NextRequest) {
  if (!isAuthenticated(req)) return NextResponse.json({ error: 'Unauthorized admin access.' }, { status: 401, headers: noStore() });
  try {
    const result = await executeEmergencyHaltAll('admin_ui');
    const newState = await getWorkerSwitchboardState();
    return NextResponse.json(
      {
        success: true,
        message: `EMERGENCY HALT EXECUTED: ${result.cancelledDatasetJobs} dataset jobs & ${result.cancelledTrainingRuns} training runs stopped.`,
        result,
        state: newState,
      },
      { headers: noStore() }
    );
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unable to execute emergency halt.' },
      { status: 500, headers: noStore() }
    );
  }
}
