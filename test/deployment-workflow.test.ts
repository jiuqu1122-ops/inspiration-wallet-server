import { readFile } from 'node:fs/promises';
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
});
