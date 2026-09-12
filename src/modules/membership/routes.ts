import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  getMembershipForUser,
  getMembershipPlans,
  getReferralSnapshot,
  validateReferralCode,
} from './service.js';

function invalid(reply: FastifyReply, message: string) {
  return reply.code(400).send({ error: 'invalid_request', message });
}

export const membershipRoutes: FastifyPluginAsync = async (app) => {
  app.get('/plans', async () => ({ items: await getMembershipPlans(app.prisma) }));

  app.get('/me', { preHandler: app.authenticateAccessToken }, async (request) => ({
    membership: await getMembershipForUser(app.prisma, request.user.sub),
  }));

  app.get('/referrals/me', { preHandler: app.authenticateAccessToken }, async (request) => (
    getReferralSnapshot(app.prisma, request.user.sub)
  ));

  app.post(
    '/referrals/validate',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = z.object({ inviteCode: z.string().trim().min(1).max(32) }).strict().safeParse(request.body);
      if (!parsed.success) return invalid(reply, 'Invite code is invalid');
      return validateReferralCode(app.prisma, parsed.data.inviteCode);
    },
  );

};

export const referralAliasRoutes: FastifyPluginAsync = async (app) => {
  app.get('/me', { preHandler: app.authenticateAccessToken }, async (request) => (
    getReferralSnapshot(app.prisma, request.user.sub)
  ));
  app.post('/validate', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const parsed = z.object({ inviteCode: z.string().trim().min(1).max(32) }).strict().safeParse(request.body);
    if (!parsed.success) return invalid(reply, 'Invite code is invalid');
    return validateReferralCode(app.prisma, parsed.data.inviteCode);
  });
};
