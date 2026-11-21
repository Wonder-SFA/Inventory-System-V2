import { ERROR_CODES, UnauthorizedError } from '@iv2/shared-domain';
import type { FastifyInstance } from 'fastify';
import type { SseBroadcaster } from './sseBroadcaster.js';

export interface RegisterSseRoutesOptions {
  broadcaster: SseBroadcaster;
}

export function registerSseRoutes(
  app: FastifyInstance,
  options: RegisterSseRoutesOptions,
): void {
  const { broadcaster } = options;

  app.get('/api/v1/events/stream', async (request, reply) => {
    const policy = request.accessPolicy;
    if (!policy) {
      throw new UnauthorizedError('Authentication required', ERROR_CODES.UNAUTHENTICATED);
    }

    let closed = false;
    const disconnect = broadcaster.connect({
      userId: policy.actor.id,
      locationScope: policy.locationScope,
      write: (chunk) => {
        if (!closed && !reply.raw.destroyed && !reply.raw.writableEnded) {
          reply.raw.write(chunk);
        }
      },
      onClose: () => {
        closed = true;
        if (!reply.raw.destroyed && !reply.raw.writableEnded) {
          reply.raw.end();
        }
      },
    });

    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.flushHeaders?.();
    reply.raw.write(': connected\n\n');

    const cleanup = () => {
      disconnect();
    };

    request.raw.once('close', cleanup);
    reply.raw.once('close', cleanup);
    reply.raw.once('error', cleanup);
  });

  app.addHook('onClose', async () => {
    broadcaster.closeAll();
  });
}
