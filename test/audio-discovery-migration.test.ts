import { readFile } from 'node:fs/promises';
import type { PrismaClient } from '@prisma/client';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { updateDiscoveryModalityOverride } from '../src/modules/ai/model-admin.js';
import { storedAiModality } from '../src/modules/ai/discovery-modality.js';

describe('audio discovery database upgrade', () => {
  const db = new PGlite();
  const oldMigration = new URL('../prisma/migrations/20260919170000_add_upstream_discovery_modality_override/migration.sql', import.meta.url);
  const audioMigration = new URL('../prisma/migrations/20261014160000_allow_audio_discovery_modality/migration.sql', import.meta.url);
  beforeAll(async () => {
    await db.exec(`CREATE TABLE "AiUpstreamDiscovery" (
      id TEXT PRIMARY KEY, status TEXT NOT NULL, "suggestedModality" TEXT
    );`);
    await db.exec(await readFile(oldMigration, 'utf8'));
    await db.exec(`INSERT INTO "AiUpstreamDiscovery" (id, status, "suggestedModality", "modalityOverride")
      VALUES ('existing-image', 'UNMAPPED', 'image', 'image'), ('music-discovery', 'UNMAPPED', 'image', NULL);`);
    await expect(db.query('UPDATE "AiUpstreamDiscovery" SET "modalityOverride" = $1 WHERE id = $2', ['audio', 'music-discovery']))
      .rejects.toMatchObject({ code: '23514', constraint: 'AiUpstreamDiscovery_modalityOverride_check' });
    await db.exec(await readFile(audioMigration, 'utf8'));
  }, 30_000);
  afterAll(() => db.close());

  it('allows an existing image suggestion to be saved as music through the admin service', async () => {
    const prisma = {
      aiUpstreamDiscovery: {
        findUnique: async ({ where }: { where: { id: string } }) => (
          await db.query('SELECT * FROM "AiUpstreamDiscovery" WHERE id = $1', [where.id])
        ).rows[0],
        update: async ({ where, data }: { where: { id: string }; data: { modalityOverride: string | null } }) => ({
          ...(await db.query('UPDATE "AiUpstreamDiscovery" SET "modalityOverride" = $1 WHERE id = $2 RETURNING *', [data.modalityOverride, where.id])).rows[0],
          channel: { id: 'channel', name: 'Music provider', kind: 'USELG', status: 'ACTIVE' },
        }),
      },
    } as unknown as PrismaClient;
    expect(await updateDiscoveryModalityOverride(prisma, 'music-discovery', 'audio')).toMatchObject({
      suggestedModality: 'image', modalityOverride: 'audio', effectiveModality: 'audio',
    });
    expect((await db.query('SELECT "modalityOverride" FROM "AiUpstreamDiscovery" WHERE id = $1', ['existing-image'])).rows)
      .toEqual([{ modalityOverride: 'image' }]);
  });

  it.each([null, 'chat', 'image', 'video', 'audio'])('keeps database and service modalities aligned for %s', async value => {
    await expect(db.query('UPDATE "AiUpstreamDiscovery" SET "modalityOverride" = $1 WHERE id = $2', [value, 'music-discovery'])).resolves.toBeDefined();
    expect(storedAiModality(value)).toBe(value);
  });

  it('still rejects unsupported modalities without changing the stored value', async () => {
    await db.query('UPDATE "AiUpstreamDiscovery" SET "modalityOverride" = $1 WHERE id = $2', ['audio', 'music-discovery']);
    await expect(db.query('UPDATE "AiUpstreamDiscovery" SET "modalityOverride" = $1 WHERE id = $2', ['invalid-modality', 'music-discovery']))
      .rejects.toMatchObject({ code: '23514', constraint: 'AiUpstreamDiscovery_modalityOverride_check' });
    expect((await db.query('SELECT "modalityOverride" FROM "AiUpstreamDiscovery" WHERE id = $1', ['music-discovery'])).rows)
      .toEqual([{ modalityOverride: 'audio' }]);
  });
});
