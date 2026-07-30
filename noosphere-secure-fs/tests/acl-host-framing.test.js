// The Windows ACL helper host runs only on Windows, so its wire format would
// otherwise be exercised only on windows-latest. The framing is the part that
// can silently hand a caller the wrong file's answer, so it is pure and it is
// tested everywhere.
import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeAclResponseFrame, encodeAclRequestFrame } from '../index.js';

function header(bytes) {
  return bytes.subarray(0, bytes.indexOf(0x0a)).toString('ascii');
}

function response(id, status, body) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  return Buffer.concat([Buffer.from(`${id} ${status} ${payload.length}\n`, 'ascii'), payload]);
}

test('a request frame declares its own payload length', () => {
  const payload = Buffer.from('owner-only bytes');
  const frame = encodeAclRequestFrame({
    id: '7', action: 'write', file: 'C:\\state\\trust.json', source: null, payload,
  });
  const [id, action, length] = header(frame).split(' ');
  assert.equal(id, '7');
  assert.equal(action, 'write');
  assert.equal(Number(length), payload.length);
  assert.deepEqual(frame.subarray(frame.indexOf(0x0a) + 1), payload);
});

test('a path with a space or a newline cannot shift a header field', () => {
  const file = 'C:\\Program Files\\a\nb\\état.json';
  const frame = encodeAclRequestFrame({ id: '1', action: 'verify', file, source: null });
  const fields = header(frame).split(' ');
  assert.equal(fields.length, 5);
  assert.equal(Buffer.from(fields[3], 'base64').toString('utf8'), file);
  // An absent source must still occupy its field, or the header collapses to four.
  assert.equal(fields[4], '-');
});

test('an absent payload produces a header-only frame', () => {
  const frame = encodeAclRequestFrame({ id: '2', action: 'sid', file: '', source: null });
  assert.equal(frame.indexOf(0x0a), frame.length - 1);
  assert.equal(header(frame).split(' ')[3], '-');
});

test('a response frame is decoded with its payload and the bytes that follow', () => {
  const bytes = Buffer.concat([response('1', 'ok', 'S-1-5-18'), response('2', 'err', 'x')]);
  const first = decodeAclResponseFrame(bytes);
  assert.deepEqual(
    { id: first.id, status: first.status, body: first.body.toString('utf8') },
    { id: '1', status: 'ok', body: 'S-1-5-18' },
  );
  const second = decodeAclResponseFrame(first.rest);
  assert.equal(second.id, '2');
  assert.equal(second.status, 'err');
  assert.equal(second.rest.length, 0);
});

test('a partial frame decodes to null rather than to a short answer', () => {
  const whole = response('1', 'ok', 'S-1-5-32-544');
  for (let cut = 0; cut < whole.length; cut += 1) {
    assert.equal(decodeAclResponseFrame(whole.subarray(0, cut)), null, `cut at ${cut}`);
  }
  assert.equal(decodeAclResponseFrame(whole).body.toString('utf8'), 'S-1-5-32-544');
});

test('a payload carrying a newline is not mistaken for a frame boundary', () => {
  const body = Buffer.from('owner:S-1-5-21-1\nwrite:S-1-5-18\n');
  const frame = decodeAclResponseFrame(response('4', 'ok', body));
  assert.deepEqual(frame.body, body);
  assert.equal(frame.rest.length, 0);
});

test('arbitrary bytes survive a round trip through both frames', () => {
  const payload = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
  const request = encodeAclRequestFrame({ id: '9', action: 'write', file: 'C:\\a', source: null, payload });
  assert.deepEqual(request.subarray(request.indexOf(0x0a) + 1), payload);
  assert.deepEqual(decodeAclResponseFrame(response('9', 'ok', payload)).body, payload);
});

test('a malformed or oversized header fails closed', () => {
  for (const bad of [
    '1 ok\n',
    '1 ok 4 extra\n',
    '1 maybe 0\n',
    '1 ok -1\n',
    '1 ok 99999999999\n',
    '1 ok nine\n',
  ]) {
    assert.throws(
      () => decodeAclResponseFrame(Buffer.from(bad, 'ascii')),
      error => error.code === 'state-acl-failed',
      bad,
    );
  }
  assert.throws(
    () => decodeAclResponseFrame(Buffer.alloc(8193, 0x20)),
    error => error.code === 'state-acl-failed',
  );
});
