export type ImageTaskActionMetadata = {
  actionId: string;
  operation: string;
  label?: string;
  requiresPrompt?: boolean;
  requiresMask?: boolean;
};

export type ImageTaskMetadata = {
  version: 1;
  taskId: string;
  actions: ImageTaskActionMetadata[];
  operation?: string;
  speed?: string;
  requiresModal?: boolean;
  parentTaskId?: string;
  expiresAt?: string;
};

const object = (value: unknown): Record<string, unknown> | undefined => value !== null
  && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const hasControl = (value: string) => {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
};
const text = (value: unknown, maximum: number) => typeof value === 'string' && value.length <= maximum
  && value.trim() && !hasControl(value)
  && !/(?:https?:\/\/|data:image\/|bearer\s|(?:api[_-]?key|authorization|secret|token|password)\s*[:=])/i.test(value)
  ? value : undefined;
const boolean = (value: unknown) => typeof value === 'boolean' ? value : undefined;

/** A bounded public projection, never a copy of an upstream response or URLs. */
function metadataFromRow(row: Record<string, unknown>, taskId: string): ImageTaskMetadata {
  const operation = text(row.operation, 64);
  const speed = text(row.speed, 64);
  const requiresModal = boolean(row.requiresModal ?? row.requires_modal);
  const parentTaskId = text(row.parentTaskId ?? row.parent_task_id, 512);
  const expiry = text(row.expiresAt ?? row.expires_at, 80);
  const expiresAt = expiry && Number.isFinite(Date.parse(expiry)) ? expiry : undefined;
  const candidates = Array.isArray(row.actions) ? row.actions : Array.isArray(row.buttons) ? row.buttons : [];
  const actions: ImageTaskActionMetadata[] = [];
  for (const candidate of candidates.slice(0, 32)) {
    const action = object(candidate);
    if (!action) continue;
    const actionId = text(action.actionId ?? action.action_id ?? action.custom_id, 512);
    const actionOperation = text(action.operation, 64);
    if (!actionId || !actionOperation || actions.some(entry => entry.actionId === actionId)) continue;
    const label = text(action.label, 200);
    const requiresPrompt = boolean(action.requiresPrompt ?? action.requires_prompt);
    const requiresMask = boolean(action.requiresMask ?? action.requires_mask);
    actions.push({ actionId, operation: actionOperation,
      ...(label !== undefined ? { label } : {}),
      ...(requiresPrompt !== undefined ? { requiresPrompt } : {}),
      ...(requiresMask !== undefined ? { requiresMask } : {}) });
  }
  return { version: 1, taskId, actions,
    ...(operation !== undefined ? { operation } : {}),
    ...(speed !== undefined ? { speed } : {}),
    ...(requiresModal !== undefined ? { requiresModal } : {}),
    ...(parentTaskId !== undefined ? { parentTaskId } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}) };
}

/** Only called after the existing task identity checks accept this snapshot. */
export function extractImageTaskMetadata(value: unknown, acceptedTaskId: string): ImageTaskMetadata | undefined {
  const taskId = text(acceptedTaskId, 512);
  if (!taskId) return undefined;
  let result: ImageTaskMetadata | undefined;
  const visit = (candidate: unknown, depth: number) => {
    const row = object(candidate);
    if (!row || depth > 4) return;
    const explicitId = row.taskId ?? row.task_id;
    if (explicitId !== undefined && explicitId !== taskId) return;
    result = mergeImageTaskMetadata(result, metadataFromRow(row, taskId));
    for (const key of ['raw', 'data', 'task', 'result', 'response', 'image_task', 'midjourney']) visit(row[key], depth + 1);
  };
  visit(value, 0);
  return result;
}

export function projectImageTaskMetadata(value: unknown): ImageTaskMetadata | undefined {
  const row = object(value);
  const taskId = text(row?.taskId, 512);
  return row?.version === 1 && taskId ? metadataFromRow(row, taskId) : undefined;
}

export function mergeImageTaskMetadata(
  previous: ImageTaskMetadata | undefined,
  next: ImageTaskMetadata | undefined,
): ImageTaskMetadata | undefined {
  if (!next) return previous;
  if (!previous) return next;
  if (previous.taskId !== next.taskId) return previous;
  return { ...previous, ...next, actions: next.actions.length ? next.actions : previous.actions };
}
