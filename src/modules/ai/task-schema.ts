import { z } from 'zod';
import { AGENT_USAGE_CONTEXTS } from './usage-context.js';

export const agentToolChoiceSchema = z.union([
  z.enum(['auto', 'none', 'required']),
  z.object({
    type: z.literal('function'),
    function: z.object({
      name: z.string().trim().min(1).max(200),
    }).strict(),
  }).strict(),
]);

export const agentTaskPayloadSchema = z.object({
  messages: z.array(z.unknown()).min(1).max(200),
  tools: z.array(z.unknown()).max(100).optional(),
  toolChoice: agentToolChoiceSchema.optional(),
  model: z.string().trim().min(1).max(200).optional(),
  usageContext: z.enum(AGENT_USAGE_CONTEXTS).optional(),
}).strict();

export const inspirationTaskPayloadSchema = z.object({
  itemId: z.string().trim().min(1).max(256),
  imageSource: z.string().min(1).max(12_000_000),
  userTags: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
  userNotes: z.array(z.string().trim().min(1).max(2_000)).max(50).optional(),
  existingProfile: z.unknown().optional(),
}).strict();

export const createAiTaskSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('agent_chat'),
    requestId: z.string().trim().min(8).max(128),
    payload: agentTaskPayloadSchema,
  }).strict(),
  z.object({
    type: z.literal('inspiration_analysis'),
    requestId: z.string().trim().min(8).max(128),
    payload: inspirationTaskPayloadSchema,
  }).strict(),
]);

export type AgentTaskPayload = z.infer<typeof agentTaskPayloadSchema>;
export type AgentToolChoice = z.infer<typeof agentToolChoiceSchema>;
export type InspirationTaskPayload = z.infer<typeof inspirationTaskPayloadSchema>;
export type CreateAiTaskInput = z.infer<typeof createAiTaskSchema>;
