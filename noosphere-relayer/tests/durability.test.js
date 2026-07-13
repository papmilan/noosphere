import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { syncDirectoryPath, syncFilePath } from '../durability.js';

describe('relayer durability fsync portability', () => {
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
    await assert.rejects(syncFilePath('/file', {
      openImpl: async () => { throw Object.assign(new Error('unsupported'), { code: 'EPERM' }); },
    }), /unsupported/);
  });
});
