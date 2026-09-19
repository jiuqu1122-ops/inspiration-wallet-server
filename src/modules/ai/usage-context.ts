export const AGENT_USAGE_CONTEXTS = [
  'chat',
  'canvas_text_agent',
  'workflow',
  'inspiration_analysis',
  'three_scene_analysis',
  'prompt_optimization',
  'system_internal',
] as const;

export type AgentUsageContext = (typeof AGENT_USAGE_CONTEXTS)[number];

const AGENT_USAGE_CONTEXT_SET = new Set<string>(AGENT_USAGE_CONTEXTS);

const REQUEST_ID_CONTEXT_PREFIXES: ReadonlyArray<readonly [string, AgentUsageContext]> = [
  ['canvas_text_agent_', 'canvas_text_agent'],
  ['workflow-planner-api-', 'workflow'],
  ['workflow-planner-', 'workflow'],
  ['workflow-plan-', 'workflow'],
  ['workflow-router-', 'workflow'],
  ['workflow_tool_', 'workflow'],
  ['workflow-summary-', 'workflow'],
  ['workflow-decision-', 'workflow'],
  ['workflow-branch-', 'workflow'],
  ['inspiration_rank_', 'inspiration_analysis'],
  ['three-analysis-', 'three_scene_analysis'],
  ['prompt-optimize-', 'prompt_optimization'],
  ['agent-api-', 'system_internal'],
  ['chat-summary-', 'system_internal'],
  ['chat-batch-plan-decision-', 'system_internal'],
];

export function canonicalAgentUsageContext(value?: string | null): AgentUsageContext | undefined {
  const normalized = value?.trim().toLowerCase() ?? '';
  return AGENT_USAGE_CONTEXT_SET.has(normalized)
    ? normalized as AgentUsageContext
    : undefined;
}

export function inferAgentUsageContext(clientRequestId: string): AgentUsageContext | undefined {
  const normalizedId = clientRequestId.trim().toLowerCase();
  return REQUEST_ID_CONTEXT_PREFIXES.find(([prefix]) => normalizedId.startsWith(prefix))?.[1];
}

export function resolveAgentUsageContext(
  explicit: string | undefined,
  clientRequestId: string,
): AgentUsageContext {
  // App-generated internal request ids are the strongest available signal.
  // They protect old or partially upgraded clients from downgrading a fixed
  // canvas/workflow request to token-billed chat.
  return inferAgentUsageContext(clientRequestId)
    ?? canonicalAgentUsageContext(explicit)
    ?? 'chat';
}

export function isFixedCanvasLlmUsageContext(value?: string | null) {
  const context = canonicalAgentUsageContext(value);
  return context === 'canvas_text_agent'
    || context === 'prompt_optimization'
    || context === 'workflow';
}
