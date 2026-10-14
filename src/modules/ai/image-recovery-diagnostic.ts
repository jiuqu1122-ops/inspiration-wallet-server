import type { FailureDiagnostic } from './failure-diagnostic.js';

const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const reasons: Record<string, string> = {
  task_identity_mismatch: '渠道查询响应中的任务标识不一致，原任务结果待确认',
  read_not_retryable: '查询或下载原任务结果受阻，结果待确认',
  read_budget_exhausted: '读取原任务结果的重试次数已用完',
  task_wait_exhausted: '原任务尚未在等待时间内完成',
  result_not_ready: '渠道任务已完成，图片结果尚未交付',
  submission_outcome_unknown: '提交响应中断，是否受理尚待确认',
};

/** Only expose bounded metadata. Provider URLs and raw responses stay private. */
export function imageRecoveryDiagnostic(result: unknown, now = new Date()) {
  const recovery = record(record(result)?.recovery);
  if (recovery?.version !== 1 || recovery.state !== 'manual_confirmation_required') return null;
  const reason = typeof recovery.reason === 'string' && Object.hasOwn(reasons, recovery.reason) ? recovery.reason : 'unknown';
  const taskId = record(recovery.identity)?.taskId;
  const recordedAt = typeof recovery.observedAt === 'string' && Number.isFinite(Date.parse(recovery.observedAt))
    ? new Date(recovery.observedAt).toISOString() : now.toISOString();
  const diagnostic: FailureDiagnostic = {
    version: 1, code: 'IMAGE_TASK_RECOVERY_REQUIRED',
    message: reasons[reason] ?? '原任务结果待确认，已停止自动重新生成',
    stage: 'request_recovery', httpStatus: null, causeCode: null, recordedAt, resolution: null,
  };
  return {
    diagnostic,
    recovery: { state: 'manual_confirmation_required' as const, reason,
      stage: ['status', 'result', 'asset'].includes(String(recovery.stage)) ? String(recovery.stage) : 'status',
      taskId: typeof taskId === 'string' && /^[\w.:-]{1,512}$/.test(taskId) ? taskId : null },
  };
}
