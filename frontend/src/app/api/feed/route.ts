import { type NextRequest, NextResponse } from 'next/server';
import { PROXY_API_BASE as API_BASE } from '@/lib/constants';

export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get('authorization');
    const { searchParams } = new URL(request.url);

    const params = new URLSearchParams();
    ['sort', 'limit', 'offset'].forEach((key) => {
      const value = searchParams.get(key);
      if (value) params.append(key, value);
    });

    const response = await fetch(`${API_BASE}/feed?${params}`, {
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
