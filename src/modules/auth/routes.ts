import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

const exchangeBodySchema = z.object({
  license: z.string().min(1).max(16_384),
});

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/license/exchange',
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '15 minutes',
        },
      },
    },
    async (request, reply) => {
      const parsed = exchangeBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'invalid_request',
          message: 'A non-empty license value is required',
        });
      }

      // TODO: Integrate the existing Inspiration Drawer license signature format,
      // revocation rules, code hashing, and user provisioning before issuing tokens.
      return reply.code(501).send({
        error: 'not_implemented',
        message: 'License verification is not configured yet',
      });
    },
  );
};
