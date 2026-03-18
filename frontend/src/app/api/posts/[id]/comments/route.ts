import { type NextRequest, NextResponse } from 'next/server';
import { PROXY_API_BASE as API_BASE } from '@/lib/constants';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const authHeader = request.headers.get('authorization');
    const { searchParams } = new URL(request.url);

    const queryParams = new URLSearchParams();
    ['sort', 'limit'].forEach((key) => {
      const value = searchParams.get(key);
      if (value) queryParams.append(key, value);
    });

    const response = await fetch(
      `${API_BASE}/posts/${id}/comments?${queryParams}`,
      {
        headers: authHeader ? { Authorization: authHeader } : {},
      },
    );

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (_error) {
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const authHeader = request.headers.get('authorization');
    if (!authHeader) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();

    const response = await fetch(`${API_BASE}/posts/${id}/comments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader,
      },
      body: JSON.stringify(body),
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
