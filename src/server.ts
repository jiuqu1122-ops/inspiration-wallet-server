import { buildApp } from './app.js';
import { env } from './config/env.js';

const app = await buildApp();

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'Shutting down');
  try {
    await app.close();
    process.exit(0);
  } catch (error) {
    app.log.error({ error }, 'Graceful shutdown failed');
    process.exit(1);
  }
};

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ host: env.HOST, port: env.PORT });
} catch (error) {
  app.log.fatal({ error }, 'Server failed to start');
  process.exit(1);
}
