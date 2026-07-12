import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { decodeEnvelope } from '../continuity/acp/wire.js';
import { renderKernel } from '../continuity/acp/render.js';

const fixturePath = new URL('./fixtures/acp/continuation-case.json', import.meta.url);

describe('ACP continuation acceptance', () => {
  it('preserves continuation-critical fields in the kernel', () => {
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
    const decoded = decodeEnvelope(fixture.envelope, { clock: fixture.clock });
    assert.equal(decoded.ok, true, JSON.stringify(decoded.errors));
    const kernel = renderKernel(decoded.state, fixture.render_options);
    for (const fragment of fixture.required_kernel_fragments) {
      assert.match(kernel, new RegExp(fragment));
    }
    assert.ok(Buffer.byteLength(kernel, 'utf8') <= 1800);
  });
});
