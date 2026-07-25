import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankTopics, type TopicCounts } from './ranking.js';

// A hand-computable fixture (design docs teaching protocol §3.5: smallest-reproducible beats
// realistic). Three topics, chosen so the GLOBAL fail rate C comes out to exactly 0.5:
//
//   total attempts = 100 + 1 + 99 = 200
//   total fails    =  60 + 1 + 39 = 100   ->   C = 100 / 200 = 0.5
//
// With m = 10 the three topics exercise the whole heuristic:
//
//   brutal-popular  100 att, 60 fail  raw 0.60  shrunk (60+5)/110 = 0.5909  ln100 4.6052  -> 2.7215
//   noise             1 att,  1 fail  raw 1.00  shrunk ( 1+5)/ 11 = 0.5455  ln  1 0.0000  -> 0.0000
//   easy-popular     99 att, 39 fail  raw ~.394 shrunk (39+5)/109 = 0.4037  ln 99 4.5951  -> 1.8551
//
// The point the fixture pins: the 100%-raw-rate "noise" topic ranks DEAD LAST at exactly 0,
// beaten by both popular topics -- shrinkage pulled its rate toward C AND log(1) zeroed its
// weight. That is the entire design goal in one assertion.
const FIXTURE: TopicCounts[] = [
  { suspect: 'crassius', topic: 'brutal-popular', attempts: 100, passes: 40 },
  { suspect: 'crassius', topic: 'noise', attempts: 1, passes: 0 },
  { suspect: 'crassius', topic: 'easy-popular', attempts: 99, passes: 60 },
];

test('global C is computed from the scored rows themselves', () => {
  const { globalFailRate } = rankTopics(FIXTURE, 10);
  assert.equal(globalFailRate, 0.5);
});

test('ranks by stuck_score: volume-weighted, shrinkage-tamed', () => {
  const { ranked } = rankTopics(FIXTURE, 10);
  assert.deepEqual(
    ranked.map((r) => r.topic),
    ['brutal-popular', 'easy-popular', 'noise'],
  );
});

test('a single-attempt topic scores EXACTLY zero (log(1) floor)', () => {
  const { ranked } = rankTopics(FIXTURE, 10);
  const noise = ranked.find((r) => r.topic === 'noise')!;
  assert.equal(noise.raw_fail_rate, 1); // 100% raw -- would top a naive sort
  assert.equal(noise.stuck_score, 0); // ...but dead last here
});

test('shrinkage pulls a thin extreme rate toward C', () => {
  const { ranked } = rankTopics(FIXTURE, 10);
  const noise = ranked.find((r) => r.topic === 'noise')!;
  // raw 1.0 -> shrunk 6/11 = 0.5455, i.e. dragged most of the way back to C = 0.5
  assert.equal(noise.shrunk_fail_rate, 0.5455);
});

test('empty input does not divide by zero', () => {
  const { globalFailRate, ranked } = rankTopics([], 10);
  assert.equal(globalFailRate, 0);
  assert.deepEqual(ranked, []);
});
