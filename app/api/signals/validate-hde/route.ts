import { NextRequest, NextResponse } from 'next/server';
import { validateHdeCompliance, getDynamicComplianceLimits } from '@/lib/hde-compliance-validator';
import { recordObservabilityEvent } from '@/lib/observability';
import { randomUUID } from 'node:crypto';

export const dynamic = 'force-dynamic';

/**
 * Server-Side HDE Compliance Validation API Endpoint
 * 
 * Verifies auto-optimizer proposals and HDE parameter selections against AGENTS.md rules:
 * - Horizon / Duration limits from live Deriv broker specifications.
 * - Dynamic risk caps and stake limits from DB configuration.
 * - Model lifecycle validation (only promoted production models).
 * - Zero Technical Indicators rule enforcement.
 */
export async function POST(req: NextRequest) {
  const correlationId = req.headers.get('x-correlation-id')?.trim() || randomUUID();
  const responseHeaders = { 'Cache-Control': 'no-store', 'x-correlation-id': correlationId };

  try {
    const body = await req.json().catch(() => ({}));
    const symbol = typeof body?.symbol === 'string' && body.symbol.trim() ? body.symbol.trim() : 'R_100';

    const validationResult = await validateHdeCompliance({
      symbol,
      horizon: body?.horizon ? {
        value: Number(body.horizon.value),
        unit: body.horizon.unit,
      } : undefined,
      stake: body?.stake !== undefined ? Number(body.stake) : undefined,
      modelId: body?.modelId ? String(body.modelId) : undefined,
      modelKey: body?.modelKey ? String(body.modelKey) : undefined,
      features: body?.features && typeof body.features === 'object' ? body.features : undefined,
      attributionMultiplier: body?.attributionMultiplier !== undefined ? Number(body.attributionMultiplier) : undefined,
      mode: body?.mode,
    });

    if (!validationResult.valid) {
      await recordObservabilityEvent({
        category: 'trading',
        severity: 'warn',
        service: 'hde-compliance-validator',
        eventType: 'hde_compliance_rejected',
        message: `HDE parameter validation rejected for ${symbol}: ${validationResult.rejectionReason}`,
        correlationId,
        symbol,
        metadata: {
          violations: validationResult.violations,
          requestParams: body,
          rejectionCode: validationResult.rejectionCode,
        },
      });

      return NextResponse.json({
        success: false,
        error: 'HDE_COMPLIANCE_VALIDATION_FAILED',
        rejectionCode: validationResult.rejectionCode,
        rejectionReason: validationResult.rejectionReason,
        parameter: validationResult.parameter,
        violations: validationResult.violations,
        limits: validationResult.limits,
        correlationId,
      }, { status: 422, headers: responseHeaders });
    }

    return NextResponse.json({
      success: true,
      status: 'ACCEPTED',
      symbol,
      limits: validationResult.limits,
      correlationId,
    }, { headers: responseHeaders });
  } catch (error: any) {
    console.error(`[HDE Compliance API Error] correlationId=${correlationId}:`, error);
    return NextResponse.json({
      success: false,
      error: error?.message || 'Internal error validating HDE compliance.',
      correlationId,
    }, { status: 500, headers: responseHeaders });
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const symbol = searchParams.get('symbol') || 'R_100';

  try {
    const limits = await getDynamicComplianceLimits(symbol);
    return NextResponse.json({
      success: true,
      symbol,
      limits,
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error: any) {
    return NextResponse.json({
      success: false,
      error: error?.message || 'Failed to retrieve compliance limits.',
    }, { status: 500 });
  }
}
