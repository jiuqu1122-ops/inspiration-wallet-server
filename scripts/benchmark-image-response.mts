import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

if (process.argv.includes('--watchdog-child')) {
  process.stdout.write('watchdog-child-ready\n');
  await new Promise<void>(() => {
    setInterval(() => {}, 60_000);
  });
}

process.env.NODE_ENV ??= 'test';
process.env.HOST ??= '127.0.0.1';
process.env.PORT ??= '3000';
process.env.APP_BASE_URL ??= 'https://benchmark.invalid';
process.env.DATABASE_URL ??= 'postgresql://benchmark:benchmark@localhost:5432/benchmark';
process.env.JWT_ACCESS_SECRET ??= 'benchmark-access-secret-at-least-32-characters';
process.env.JWT_REFRESH_SECRET ??= 'benchmark-refresh-secret-different-at-least-32-characters';
process.env.PROVIDER_SECRETS_ENCRYPTION_KEY ??= Buffer.alloc(32, 1).toString('base64');

const imageService = await import(process.env.IMAGE_RESPONSE_BENCHMARK_MODULE
  ? pathToFileURL(process.env.IMAGE_RESPONSE_BENCHMARK_MODULE).href
  : '../src/modules/ai/image-service.js');
const summarizeUselgImageStatus = imageService.summarizeUselgImageStatus;
const parseProviderResponse: (text: string) => { value: unknown } =
  typeof imageService.parseProviderResponse === 'function'
    ? imageService.parseProviderResponse
    : text => ({ value: JSON.parse(text) as unknown });

type Measurement = {
  sizeMb: number;
  mode: 'single' | 'dual';
  parseMs: number;
  extractMs: number;
  totalMs: number;
  eventLoopDelayMs: number;
  imageCount: number;
};

function milliseconds(value: number) {
  return Number(value.toFixed(3));
}

async function measure(sizeMb: number, copies: 1 | 2): Promise<Measurement> {
  const targetLength = sizeMb * 1024 * 1024;
  const base64 = `iVBORw0KGgo${'A'.repeat(Math.max(0, targetLength - 12))}`;
  const responseText = `{"status":"success","data":[{"b64_json":"${base64}"}]}`;
  let timerFiredAt = 0;
  const timerScheduledAt = performance.now();
  const timer = new Promise<void>(resolve => {
    setTimeout(() => {
      timerFiredAt = performance.now();
      resolve();
    }, 0);
  });

  const totalStartedAt = performance.now();
  let parseMs = 0;
  let extractMs = 0;
  let imageCount = 0;
  const processOneResponse = () => {
    const parseStartedAt = performance.now();
    const parsed = parseProviderResponse(responseText);
    parseMs += performance.now() - parseStartedAt;
    const extractStartedAt = performance.now();
    const summary = summarizeUselgImageStatus(parsed.value, [], 1);
    extractMs += performance.now() - extractStartedAt;
    imageCount += summary.images.length;
  };
  await Promise.all(Array.from(
    { length: copies },
    () => Promise.resolve().then(processOneResponse),
  ));
  const totalMs = performance.now() - totalStartedAt;
  await timer;

  return {
    sizeMb,
    mode: copies === 1 ? 'single' : 'dual',
    parseMs: milliseconds(parseMs),
    extractMs: milliseconds(extractMs),
    totalMs: milliseconds(totalMs),
    eventLoopDelayMs: milliseconds(Math.max(0, timerFiredAt - timerScheduledAt)),
    imageCount,
  };
}

async function verifyParentWatchdog() {
  const child = spawn(process.execPath, [
    ...process.execArgv,
    process.argv[1]!,
    '--watchdog-child',
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let ready = false;
  let terminatedByWatchdog = false;
  child.stdout.on('data', chunk => {
    if (String(chunk).includes('watchdog-child-ready')) ready = true;
  });
  const startedAt = performance.now();
  await new Promise<void>((resolve, reject) => {
    const watchdog = setTimeout(() => {
      terminatedByWatchdog = true;
      child.kill();
    }, 750);
    child.once('error', error => {
      clearTimeout(watchdog);
      reject(error);
    });
    child.once('exit', () => {
      clearTimeout(watchdog);
      resolve();
    });
  });
  return {
    ready,
    terminatedByWatchdog,
    elapsedMs: milliseconds(performance.now() - startedAt),
  };
}

const measurements: Measurement[] = [];
for (const sizeMb of [2, 8, 16]) {
  measurements.push(await measure(sizeMb, 1));
  measurements.push(await measure(sizeMb, 2));
}

console.log(JSON.stringify({
  runtime: process.version,
  platform: `${process.platform}/${process.arch}`,
  measurements,
  hangingChild: await verifyParentWatchdog(),
}, null, 2));
