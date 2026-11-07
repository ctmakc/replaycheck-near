import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonical, specHash, sha256hex, eventsOf } from '../src/near.js';
import { fmtNear, parseNear } from '../src/config.js';

test('canonical JSON sorts keys at every level and ignores key order', () => {
  const a = { b: 1, a: { d: [1, { z: 1, y: 2 }], c: 'x' } };
  const b = { a: { c: 'x', d: [1, { y: 2, z: 1 }] }, b: 1 };
  assert.equal(canonical(a), canonical(b));
  assert.equal(canonical(a), '{"a":{"c":"x","d":[1,{"y":2,"z":1}]},"b":1}');
});

test('specHash is sha256 of canonical({tasks}) and is stable', () => {
  const tasks = [{ id: 't', name: 'n', startUrl: 'https://x', steps: [], expect: [{ urlContains: '/a' }] }];
  const h = specHash(tasks);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(h, sha256hex(canonical({ tasks })));
  assert.equal(h, specHash(JSON.parse(JSON.stringify(tasks))));
  assert.notEqual(h, specHash([{ ...tasks[0], name: 'changed' }]));
});

test('sha256 known vector', () => {
  assert.equal(sha256hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('NEP-297 events are parsed from logs and filtered by standard', () => {
  const logs = [
    'plain log',
    'EVENT_JSON:{"standard":"replaycheck_market","version":"1.0.0","event":"pay","data":[{"payer":"a.testnet","to":"w.testnet","amount":"5","memo":"rc-1"}]}',
    'EVENT_JSON:{"standard":"nep141","version":"1.0.0","event":"ft_transfer","data":[{"amount":"1"}]}',
    'EVENT_JSON:not json',
  ];
  const ev = eventsOf(logs);
  assert.equal(ev.length, 1);
  assert.deepEqual(ev[0], { event: 'pay', payer: 'a.testnet', to: 'w.testnet', amount: '5', memo: 'rc-1' });
});

test('NEAR amount formatting round-trips', () => {
  assert.equal(fmtNear(parseNear('0.05')), '0.05');
  assert.equal(fmtNear(parseNear('12')), '12');
  assert.equal(parseNear('0.001').toString(), '1000000000000000000000');
  assert.equal(fmtNear(1n, 6), '0');
});
