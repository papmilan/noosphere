import { lstat, stat } from 'node:fs/promises';
import { writeOwnerOnlyFileExclusive } from '@noosphere/secure-fs';
import { syncDirectoryPath } from './durability.js';

const [filename, expectedDev, expectedIno] = process.argv.slice(2);
const SAFE_NAME = /^sha256-[0-9a-f]{64}\.json$/;
const MAX_BYTES = 1_048_576;

try {
  if (!SAFE_NAME.test(filename)) fail('quarantine-writer-failed');
  const directory = await stat('.');
  if (String(directory.dev) !== expectedDev || String(directory.ino) !== expectedIno) {
    fail('quarantine-directory-mismatch');
  }
  const existing = await lstat(filename).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (existing?.isSymbolicLink()) fail('quarantine-symlink');
  if (existing) fail('quarantine-exists');
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_BYTES) fail('quarantine-too-large');
    chunks.push(chunk);
  }
  try {
    await writeOwnerOnlyFileExclusive(filename, Buffer.concat(chunks, size), { root: process.cwd() });
  } catch (error) {
    if (error.code === 'state-file-symlink') fail('quarantine-symlink');
    if (error.code === 'state-file-exists') fail('quarantine-exists');
    throw error;
  }
  await syncDirectoryPath('.');
} catch (error) {
  process.stderr.write(`${error.code || 'quarantine-writer-failed'}\n`);
  process.exitCode = 1;
}

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}
