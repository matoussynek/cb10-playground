import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noteFrequency, normalizeProgram, serialize, runSteps } from '../js/program.js';

test('noteFrequency', () => {
  assert.equal(noteFrequency('A4'), 440);
  assert.equal(Math.round(noteFrequency('A5')), 880);
  assert.equal(Math.round(noteFrequency('C4') * 100) / 100, 261.63);
  assert.equal(Math.round(noteFrequency('C#4')), Math.round(noteFrequency('Db4')));
  assert.throws(() => noteFrequency('H2'));
});

test('normalizeProgram clamps values, drops junk and limits nesting', () => {
  const p = normalizeProgram({
    steps: [
      { type: 'run', motor: 'X', speed: 500, duration: -1 },
      { type: 'bogus' },
      null,
      { type: 'repeat', times: 0, steps: [{ type: 'repeat', steps: [{ type: 'repeat', steps: [] }] }] },
      { type: 'tone', note: 'Z9' },
    ],
  });
  const [run, rep, tone] = p.steps;
  assert.equal(p.steps.length, 3);
  assert.deepEqual([run.motor, run.speed, run.duration], ['A', 100, 0]);
  assert.equal(rep.times, 1);
  assert.equal(rep.steps.length, 1);
  assert.equal(rep.steps[0].steps.length, 0, 'third level repeat is dropped');
  assert.equal(tone.note, 'A5');
  const round = normalizeProgram(serialize(p));
  assert.deepEqual(serialize(round), serialize(p));
  assert.ok(!('id' in serialize(p).steps[0]));
});

function fakeMotors() {
  const calls = [];
  return { calls, set: v => calls.push(v), stopAll: () => calls.push('stopAll') };
}
const audio = { tone: async () => {}, song: async () => {} };

test('runSteps runs motors for the duration, repeats, and reports steps', async () => {
  const motors = fakeMotors();
  const seen = [];
  const { steps } = normalizeProgram({
    steps: [{ type: 'repeat', times: 2, steps: [{ type: 'run', motor: 'both', speed: -40, duration: 0.02 }] }, { type: 'stop' }],
  });
  await runSteps(steps, { motors, audio, signal: new AbortController().signal, onStep: id => seen.push(id) });
  assert.deepEqual(motors.calls, [{ A: -40, B: -40 }, { A: 0, B: 0 }, { A: -40, B: -40 }, { A: 0, B: 0 }, { A: 0, B: 0 }]);
  assert.equal(seen.filter(id => id === steps[0].id).length, 3);
});

test('runSteps aborts mid-step', async () => {
  const motors = fakeMotors();
  const ctl = new AbortController();
  const { steps } = normalizeProgram({ steps: [{ type: 'run', motor: 'A', speed: 50, duration: 5 }, { type: 'wait', seconds: 5 }] });
  const t0 = Date.now();
  setTimeout(() => ctl.abort(new Error('stop')), 30);
  await assert.rejects(runSteps(steps, { motors, audio, signal: ctl.signal, onStep: () => {} }), /stop/);
  assert.ok(Date.now() - t0 < 500);
  assert.deepEqual(motors.calls, [{ A: 50 }]);
});
