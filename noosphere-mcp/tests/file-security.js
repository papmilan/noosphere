import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { access, lstat } from 'node:fs/promises';

export async function assertOwnerOnlyFile(file, options = {}) {
  const details = await lstat(file);
  assert.equal(details.isFile(), true, `${file} must be a regular file`);
  assert.equal(details.isSymbolicLink(), false, `${file} must not be a symbolic link`);
  await access(file, constants.R_OK | constants.W_OK);
  if ((options.platform ?? process.platform) !== 'win32') {
    assert.equal(details.mode & 0o777, 0o600, `${file} must be mode 0600`);
  }
}

export async function assertOwnerOnlyDirectory(directory, options = {}) {
  const details = await lstat(directory);
  assert.equal(details.isDirectory(), true, `${directory} must be a directory`);
  assert.equal(details.isSymbolicLink(), false, `${directory} must not be a symbolic link`);
  await access(directory, constants.R_OK | constants.W_OK);
  if ((options.platform ?? process.platform) !== 'win32') {
    assert.equal(details.mode & 0o777, 0o700, `${directory} must be mode 0700`);
  }
}
