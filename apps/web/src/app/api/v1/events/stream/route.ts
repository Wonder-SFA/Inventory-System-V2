export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const apiInternalUrl = process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:3001';

export async function GET(request: Request): Promise<Response> {
  const forwardHeaders = new Headers();
  const cookie = request.headers.get('cookie');
  if (cookie) {
    forwardHeaders.set('cookie', cookie);
  }
  const authorization = request.headers.get('authorization');
  if (authorization) {
    forwardHeaders.set('authorization', authorization);
  }
  forwardHeaders.set('accept', 'text/event-stream');

  const upstream = await fetch(`${apiInternalUrl}/api/v1/events/stream`, {
    method: 'GET',
    headers: forwardHeaders,
    cache: 'no-store',
    signal: request.signal,
  });

  if (!upstream.ok || !upstream.body) {
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
      },
    });
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}
