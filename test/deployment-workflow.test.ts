import { readFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const projectFile = (path: string) => new URL(`../${path}`, import.meta.url);

describe('low-memory production deployment workflow', () => {
  it('pulls the immutable GitHub Actions image and never builds on production', async () => {
    const [compose, deploy, workflow] = await Promise.all([
      readFile(projectFile('docker-compose.yml'), 'utf8'),
      readFile(projectFile('scripts/deploy.sh'), 'utf8'),
      readFile(projectFile('.github/workflows/backend-image.yml'), 'utf8'),
    ]);

    expect(compose).toContain('ghcr.io/jiuqu1122-ops/inspiration-wallet-server:latest');
    expect(compose).not.toMatch(/^\s+build:/m);
    expect(deploy).toContain(':sha-${source_revision}');
    expect(deploy).toContain('docker compose pull api worker');
    expect(deploy).not.toContain('docker compose build');
    expect(workflow).toContain('name: Build backend image');
    expect(workflow).toContain('ghcr.io/${{ github.repository }}:sha-${{ github.sha }}');
  });

  it('overrides a stale inherited image with the checkout revision and exports it to Compose', async () => {
    const deploy = await readFile(projectFile('scripts/deploy.sh'), 'utf8');
    const imageSelection = deploy.match(/^deployment_image=.*\r?\nexport BACKEND_IMAGE=.*$/m)?.[0];
    expect(imageSelection).toBeDefined();
    const bash = process.platform === 'win32'
      ? join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe')
      : 'bash';
    const output = execFileSync(bash, ['-c', `${imageSelection}\nprintenv BACKEND_IMAGE`], {
      encoding: 'utf8',
      env: { ...process.env, BACKEND_IMAGE: 'old-registry.example/backend:stale',
        BACKEND_IMAGE_REPOSITORY: 'ghcr.io/jiuqu1122-ops/inspiration-wallet-server', source_revision: 'fixture-revision' },
    });
    expect(output.trim()).toBe('ghcr.io/jiuqu1122-ops/inspiration-wallet-server:sha-fixture-revision');
  });

  it.each([
    ['401', '0', true], ['404', '0', false], ['414', '0', false],
    ['200', '0', false], ['000', '7', false],
  ])('accepts only a registered, authenticated recovery route (HTTP %s, transport exit %s)', async (status, curlExit, success) => {
    const deploy = (await readFile(projectFile('scripts/deploy.sh'), 'utf8')).replace(/\r\n/g, '\n');
    const check = deploy.match(/^log 'Checking 128-character image recovery route support\.\.\.'[\s\S]*?(?=^log 'Deployment workflow completed)/m)?.[0];
    expect(check).toBeDefined();
    const bash = process.platform === 'win32'
      ? join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe') : 'bash';
    const fixture = `set -euo pipefail
log() { :; }
fail() { printf '%s\\n' "$*" >&2; exit 1; }
curl() {
  local url="\${@: -1}"
  [[ "$*" == *'--request POST'* ]] || return 90
  [[ "$*" == *'Content-Type: application/json'* ]] || return 91
  [[ "$*" != *'Authorization:'* ]] || return 92
  [[ "$url" == 'https://probe.example/v1/ai/images/generations/by-request/'*'/recover' ]] || return 93
  local id="\${url##*/by-request/}"
  id="\${id%/recover}"
  [[ "\${#id}" -eq 128 ]] || return 94
  printf '%s' "$PROBE_HTTP_STATUS"
  return "$PROBE_CURL_EXIT"
}
${check}`;
    const result = spawnSync(bash, ['-c', fixture], { encoding: 'utf8', timeout: 5_000,
      env: { ...process.env, IMAGE_RECOVERY_SMOKE_BASE_URL: 'https://probe.example', PROBE_HTTP_STATUS: status, PROBE_CURL_EXIT: curlExit },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(success ? 0 : 1);
    if (!success) expect(result.stderr).toContain('Image recovery route smoke check');
  });
});
