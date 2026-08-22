import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { getMobileUpdateManifest, getMobileUpdateSignedUrl } from './update-store.js';

function redirectToMobileObject(
  object: 'manifest' | 'apk',
  reply: FastifyReply,
) {
  try {
    return reply
      .header('cache-control', object === 'apk' ? 'public, max-age=300' : 'no-cache')
      .redirect(getMobileUpdateSignedUrl(object));
  } catch {
    return reply.code(503).send({
      error: 'mobile_update_unavailable',
      message: 'Mobile update storage is temporarily unavailable',
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
    async (_request, reply) => redirectToMobileObject('apk', reply),
  );
};
