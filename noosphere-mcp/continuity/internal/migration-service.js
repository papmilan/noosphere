import fs from 'node:fs/promises';
import path from 'node:path';

import { APPROVABLE_SLOTS } from '../slot-sources.js';
import { TrustStoreError } from '../trust-store-internal.js';
import { homeDir } from '../trust-store-internal.js';
import { approveSlot } from './approval-service.js';
import { readLegacyTrustInventory } from './legacy-trust-inventory.js';
import { createFormatV2Store } from './trust-format-v2.js';

function assertInteractive({ input = process.stdin, output = process.stdout } = {}) {
  if (!input.isTTY || !output.isTTY) {
    throw new TrustStoreError(
      'migration-requires-tty',
      'trust migration requires an interactive terminal',
    );
  }
}

async function readCurrentState(store, projectRoot, slot) {
  const bindingFile = store.bindingPath(projectRoot);
  try {
    await fs.lstat(bindingFile);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return Object.freeze({
        binding: null,
        state: 'pristine-unapproved',
        generation: 0,
        recordId: null,
        recordHash: null,
      });
    }
    throw error;
  }
  const binding = await store.readProjectBinding(projectRoot);
  return Object.freeze({
    binding,
    ...await store.classifySlot({ binding, slot }),
  });
}

async function retirePhase4bStore(env) {
  const source = path.join(homeDir(env), 'trust-v2');
  const destination = path.join(homeDir(env), 'trust-v2-retired-phase4b');
  try {
    await fs.lstat(destination);
    const error = new TrustStoreError(
      'migration-retired-store-exists',
      'retired Phase 4B store already exists while the active store is legacy',
    );
    throw error;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await fs.rename(source, destination);
}

export async function migrateTrustInventory({
  projectRoot,
  env = process.env,
  secureFileOptions = {},
  confirm,
  input,
  output,
  now,
} = {}) {
  if (!confirm) assertInteractive({ input, output });
  const inventory = await readLegacyTrustInventory({
    root: projectRoot,
    env,
    secureFileOptions,
  });
  const result = {};
  let phase4bStoreIsActive = inventory.phase4bStore === 'trust-v2';
  for (const slot of APPROVABLE_SLOTS) {
    const store = createFormatV2Store({ env, secureFileOptions, now });
    let current;
    const legacy = inventory.slots[slot];
    current = phase4bStoreIsActive
      ? Object.freeze({
          binding: null,
          state: 'pristine-unapproved',
          generation: 0,
          recordId: null,
          recordHash: null,
        })
      : await readCurrentState(store, projectRoot, slot);
    if (current.state === 'approved') {
      result[slot] = 'already-migrated';
      continue;
    }
    if (current.state === 'revoked') {
      result[slot] = 'revoked';
      continue;
    }
    if (current.state !== 'pristine-unapproved') {
      throw new TrustStoreError(
        'authority-history-invalid',
        `${slot} has invalid Phase 4C history`,
      );
    }

    if (!legacy || legacy.classification !== 'eligible') {
      result[slot] = legacy?.classification ?? 'absent';
      continue;
    }
    const expectedCurrent = Object.freeze({
      state: 'pristine-unapproved',
      generation: 0,
      recordId: null,
      recordHash: null,
    });
    const migrationConfirm = confirm
      ? details => confirm(Object.freeze({
          ...details,
          action: 'migration-approval',
          legacyFormats: legacy.legacyFormats,
        }))
      : undefined;
    await approveSlot({
      projectRoot,
      slot,
      env,
      secureFileOptions,
      input,
      output,
      now,
      confirm: migrationConfirm,
      sourceOrigin: `cli:trust-migrate:${slot}`,
      expectedCurrent,
      bindingProjectIdentity: inventory.phase4bProjectIdentity ?? undefined,
      afterConfirmation: legacy.legacyFormats.includes('phase4b-format-2')
        ? async () => {
            if (phase4bStoreIsActive) {
              await retirePhase4bStore(env);
              phase4bStoreIsActive = false;
            }
          }
        : undefined,
    });
    result[slot] = 'migrated';
  }
  return Object.freeze({
    inventory,
    slots: Object.freeze(result),
  });
}
