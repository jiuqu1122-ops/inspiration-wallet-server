import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { CloudAiError, executeWalletAgentChat } from './service.js';

const chatSchema = z.object({
  clientRequestId: z.string().trim().min(8).max(128),
  messages: z.array(z.unknown()).min(1).max(200),
  tools: z.array(z.unknown()).max(100).optional(),
}).strict();

function knownError(reply: FastifyReply, error: unknown) {
  if (error instanceof CloudAiError) {
    return reply.code(error.statusCode).send({ error: error.code, message: error.message });
  }
  throw error;
}

export const aiRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/chat/completions',
    {
      preHandler: app.authenticateAccessToken,
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const parsed = chatSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', message: 'Agent 请求格式无效' });
      }
      try {
        return await executeWalletAgentChat(app.prisma, {
          userId: request.user.sub,
          ...parsed.data,
        });
      } catch (error) {
        return knownError(reply, error);
      }
    },
  );
};
