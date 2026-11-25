import { serviceLogger } from '../../config/logger.js';

export function videoLogHost(source: string) {
  try {
    const url = new URL(source);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.hostname : null;
  } catch {
    return null;
  }
}

export function logVideoEvent(event: string, fields: {
  source?: string;
  taskId?: string;
  providerId?: string;
  status?: number;
  durationMs?: number;
  bytes?: number;
}) {
  const { source, ...metrics } = fields;
  serviceLogger.info({ event, ...metrics, ...(source ? { host: videoLogHost(source) } : {}) });
}
