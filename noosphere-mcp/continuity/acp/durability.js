import { open } from 'node:fs/promises';

const WINDOWS_UNSUPPORTED_DIRECTORY_SYNC = new Set(['EACCES', 'EISDIR', 'EINVAL', 'ENOTSUP', 'EPERM']);

export async function syncFilePath(target, options = {}) {
  return syncOpenedPath(target, 'r+', options.openImpl ?? open);
}

export async function syncDirectoryPath(target, options = {}) {
  try {
    await syncOpenedPath(target, 'r', options.openImpl ?? open);
  } catch (error) {
    if ((options.platform ?? process.platform) === 'win32'
      && WINDOWS_UNSUPPORTED_DIRECTORY_SYNC.has(error.code)) return;
    throw error;
  }
}

async function syncOpenedPath(target, flags, openImpl) {
  const handle = await openImpl(target, flags);
  try { await handle.sync(); } finally { await handle.close(); }
}
