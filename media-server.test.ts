import { describe, expect, it } from 'vitest';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import plugin from './server.js';

describe('media attachment resolution', () => {
  it('resolves vault-root and basename embeds and issues host-aware preview URLs', async () => {
    const roots: string[] = [];
    const { bb, harness } = createFakePluginHost({ pluginId: 'wikilinks', sdk: {
      environments: { get: async () => ({ path: '/media-vault', hostId: 'media-host' }) as never },
      hosts: { pathsExist: async ({ paths }) => ({ existence: Object.fromEntries(paths.map(p => [p, p === '/media-vault/Images/chart one.jpg'])) }) },
      files: {
        listPaths: async () => ({ paths: [{ kind: 'file', path: 'Images/demo.mp4' }], truncated: false }) as never,
        createPreview: async ({ rootPath, hostId }) => { expect(hostId).toBe('media-host'); roots.push(rootPath); return { baseUrl: '/preview/token/', expiresAtMs: 123 }; },
      },
    }});
    await plugin(bb);
    const input = { path: 'notes/Note.md', source: { kind: 'workspace', environmentId: 'media-env-server', threadId: null, projectId: null } };
    try {
      expect(await harness.behavior.callRpc('resolve_media', { ...input, reference: 'Images/chart one.jpg' })).toEqual({ url: '/preview/token/chart%20one.jpg', expiresAtMs: 123 });
      expect(await harness.behavior.callRpc('resolve_media', { ...input, reference: 'demo.mp4' })).toEqual({ url: expect.stringMatching(/^\/api\/v1\/plugins\/wikilinks\/http\/media\?key=/), expiresAtMs: 123 });
      expect(roots).toEqual(['/media-vault/Images','/media-vault/Images']);
      expect(await harness.behavior.callRpc('resolve_media', { ...input, reference: 'nested/../../../outside.mp4' })).toEqual({ url: null, expiresAtMs: 0 });
      await expect(harness.behavior.callRpc('resolve_media', { ...input, reference: 'https://example.com/demo.mp4' })).rejects.toThrow();
    } finally { await harness.lifecycle.dispose(); }
  });
});
