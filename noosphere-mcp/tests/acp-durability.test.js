import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { syncDirectoryPath, syncFilePath } from '../continuity/acp/durability.js';

describe('ACP durability fsync portability', () => {
  it('opens regular files write-capable while keeping directory handles read-only', async () => {
    const opened = [];
    const openImpl = async (target, flags) => {
      opened.push({ target, flags });
      return { sync: async () => undefined, close: async () => undefined };
    };
    await syncFilePath('/file', { openImpl });
    await syncDirectoryPath('/directory', { openImpl });
    assert.deepEqual(opened, [
      { target: '/file', flags: 'r+' },
      { target: '/directory', flags: 'r' },
    ]);
  });

  it('suppresses only known unsupported Windows directory-sync errors', async () => {
    for (const code of ['EACCES', 'EISDIR', 'EINVAL', 'ENOTSUP', 'EPERM']) {
      await syncDirectoryPath('/directory', {
        platform: 'win32', openImpl: async () => { throw Object.assign(new Error(code), { code }); },
      });
    }
    await assert.rejects(syncDirectoryPath('/directory', {
      platform: 'win32', openImpl: async () => { throw Object.assign(new Error('disk'), { code: 'EIO' }); },
    }), /disk/);
    await assert.rejects(syncDirectoryPath('/directory', {
      platform: 'linux', openImpl: async () => { throw Object.assign(new Error('permission'), { code: 'EPERM' }); },
    }), /permission/);
  });

  it('never suppresses file fsync failures', async () => {
    let closed = false;
    await assert.rejects(syncFilePath('/file', {
      platform: 'win32',
      openImpl: async () => ({
        sync: async () => { throw Object.assign(new Error('unsupported'), { code: 'EPERM' }); },
        close: async () => { closed = true; },
      }),
    }), /unsupported/);
    assert.equal(closed, true);
  });
});
