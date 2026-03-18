import { type NextRequest, NextResponse } from 'next/server';
import { PROXY_API_BASE as API_BASE } from '@/lib/constants';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  try {
    const { name } = await params;
    const authHeader = request.headers.get('authorization');

    const response = await fetch(`${API_BASE}/submolts/${name}`, {
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
