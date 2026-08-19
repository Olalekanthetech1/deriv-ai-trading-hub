import assert from 'node:assert/strict';

const VALID = new Set(['open', 'acknowledged', 'investigating', 'resolved']);

function normalize(value) {
  const status = String(value ?? '').toLowerCase();
  return VALID.has(status) ? status : null;
}

function canTransition(from, to) {
  if (from === to) return true;
  if (from === 'open') return ['acknowledged', 'investigating', 'resolved'].includes(to);
  if (from === 'acknowledged') return ['investigating', 'resolved'].includes(to);
  if (from === 'investigating') return to === 'resolved';
  return to === 'open';
}

assert.equal(normalize('warning'), null);
assert.equal(normalize(' ACKNOWLEDGED '), null);
assert.equal(normalize('resolved'), 'resolved');

for (const status of ['open', 'acknowledged', 'investigating', 'resolved']) {
  assert.equal(canTransition(status, status), true);
}

assert.equal(canTransition('open', 'acknowledged'), true);
assert.equal(canTransition('open', 'investigating'), true);
assert.equal(canTransition('open', 'resolved'), true);
assert.equal(canTransition('acknowledged', 'investigating'), true);
assert.equal(canTransition('acknowledged', 'resolved'), true);
assert.equal(canTransition('investigating', 'resolved'), true);
assert.equal(canTransition('resolved', 'open'), true);

assert.equal(canTransition('acknowledged', 'open'), false);
assert.equal(canTransition('investigating', 'open'), false);
assert.equal(canTransition('investigating', 'acknowledged'), false);
assert.equal(canTransition('resolved', 'acknowledged'), false);
assert.equal(canTransition('resolved', 'investigating'), false);

console.log('[Incident Lifecycle Guard] passed');
