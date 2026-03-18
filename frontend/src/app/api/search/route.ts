import { type NextRequest, NextResponse } from 'next/server';
import { PROXY_API_BASE as API_BASE } from '@/lib/constants';

export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get('authorization');
    const { searchParams } = new URL(request.url);

    const q = searchParams.get('q');
    if (!q) {
      return NextResponse.json(
        { error: 'Query parameter q is required' },
        { status: 400 },
      );
    }

    const params = new URLSearchParams({ q });
    const limit = searchParams.get('limit');
    if (limit) params.append('limit', limit);

    const response = await fetch(`${API_BASE}/search?${params}`, {
      headers: authHeader ? { Authorization: authHeader } : {},
    });

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (_error) {
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
