import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { getMobileUpdateManifest, getMobileUpdateStream } from './update-store.js';

async function streamMobileApk(
  reply: FastifyReply,
) {
  try {
    const response = await getMobileUpdateStream('apk');
    const headers = response.res.headers;
    const contentLength = headers['content-length'];
    const output = reply
      .header('cache-control', 'public, max-age=300')
      .header('content-type', 'application/vnd.android.package-archive')
      .header('content-disposition', 'attachment; filename="Inspiration-Drawer-Mobile-arm64.apk"');
    if (typeof contentLength === 'string' || typeof contentLength === 'number') {
      output.header('content-length', contentLength);
    }
    return output.send(response.stream);
  } catch {
    return reply.code(503).send({
      error: 'mobile_update_unavailable',
      message: 'Mobile update APK is temporarily unavailable',
    });
  }
}

export const mobileRoutes: FastifyPluginAsync = async (app) => {
  app.get('/latest', async (_request, reply) => {
    try {
      return reply
        .header('cache-control', 'no-cache')
        .header('cross-origin-resource-policy', 'cross-origin')
        .send(await getMobileUpdateManifest());
    } catch (error) {
      app.log.error({ error }, 'Mobile update manifest unavailable');
      return reply.code(503).send({
        error: 'mobile_update_unavailable',
        message: 'Mobile update manifest is temporarily unavailable',
      });
    }
  });
  app.get(
    '/apk',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (_request, reply) => streamMobileApk(reply),
  );
};
