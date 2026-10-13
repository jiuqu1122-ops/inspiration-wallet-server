import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
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
});
