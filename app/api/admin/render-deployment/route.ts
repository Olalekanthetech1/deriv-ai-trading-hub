import { NextRequest, NextResponse } from 'next/server';
import { verifySessionToken } from '../auth/route';

export async function GET(req: NextRequest) {
  // Simple auth check using the standard admin cookie/header pattern used in other routes
  const cookieToken = req.cookies.get('admin_session_token')?.value;
  const headerToken = req.headers.get('x-admin-token') || req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!verifySessionToken(cookieToken) && !verifySessionToken(headerToken)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const apiKey = process.env.RENDER_API_KEY;
  const serviceId = process.env.RENDER_SERVICE_ID;

  if (!apiKey || !serviceId) {
    return NextResponse.json({ success: true, configured: false, error: 'Render monitoring not configured in environment.' });
  }

  try {
    const res = await fetch(`https://api.render.com/v1/services/${serviceId}/deploys?limit=1`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
      cache: 'no-store',
    });

    if (!res.ok) {
      console.error(`[Render API Error] HTTP ${res.status}`);
      return NextResponse.json({ success: false, configured: true, error: `Failed to fetch from Render (HTTP ${res.status})` });
    }

    const data = await res.json();
    const latest = data[0]?.deploy;

    if (!latest) {
      return NextResponse.json({ success: true, configured: true, deploy: null });
    }

    return NextResponse.json({
      success: true,
      configured: true,
      deploy: {
        id: latest.id,
        status: latest.status,
        createdAt: latest.createdAt,
        finishedAt: latest.finishedAt,
        commit: latest.commit?.id ? latest.commit.id.substring(0, 7) : null,
        message: latest.commit?.message || 'Manual deploy',
      }
    });
  } catch (error) {
    console.error('[Render API Error]', error);
    return NextResponse.json({ success: false, configured: true, error: 'Network error fetching deployment status' }, { status: 500 });
  }
}
