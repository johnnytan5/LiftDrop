// node --test lib/fleet.test.ts (mock store, no Supabase)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { beat, fleet } from './fleet.ts';
import { resetDb } from './db.ts';

test('robots keep their number, go offline after 5 s and are forgotten after 10 min', async () => {
  resetDb();
  const t = 1_000_000;
  assert.equal(await beat({ session: 'tab-a', floor: 1 }, t), 'LD-01');
  assert.equal(await beat({ session: 'tab-b', floor: 23 }, t + 100), 'LD-02');
  assert.equal(await beat({ session: 'tab-a', floor: 2 }, t + 6000), 'LD-01'); // same robot, same name
  const now = await fleet(t + 6500);
  assert.deepEqual(now.map((r) => [r.name, r.online, r.floor]), [['LD-01', true, 2], ['LD-02', false, 23]]);
  assert.deepEqual((await fleet(t + 11 * 60_000)).map((r) => r.name), []);
  await assert.rejects(beat({}), /session required/);
});
