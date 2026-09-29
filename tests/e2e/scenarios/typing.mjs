// Keys reach the shell in the order typed, and echo costs one round trip.
// Guards: "ecoh" for "echo" (requests overtaking each other).
import { sleep, tagOf } from '../lib.mjs';
export const meta = { about: 'typed text arrives in order; echo latency on a 150 ms link', ssh: true };

export async function run({ b, t }) {
  const i = await b.connect();
  const st = (await b.state())[i];
  t.ok(st.sse, 'output over SSE');

  await b.network({ latency: 150 });
  await sleep(300);
  const lat = [];
  for (const c of 'abcxyz') {
    const t0 = Date.now();
    await b.type(i, c);
    for (let k = 0; k < 400; k++) {
      const cur = await b.ev(`(() => { const p = Object.values(panes)[${i}]; const bf = p.term.buffer.active;
        return bf.getLine(bf.baseY + bf.cursorY).translateToString(true); })()`);
      if (cur.trimEnd().endsWith(c)) { lat.push(Date.now() - t0); break; }
      await sleep(5);
    }
  }
  await b.type(i, '\x15');
  await sleep(500);
  t.note('echo latency, ms: ' + lat.join(' '));
  t.ok(lat.length === 6 && Math.max(...lat.slice(1)) < 600, 'echo within ~one round trip');

  const word = tagOf('T') + '_0123456789_abcdefghijklmnopqrstuvwxyz_ZYXWVUTSRQ';
  b.requests.input = 0;
  await b.type(i, `echo ${word}\r`);         // every key at once: a fast typist, key repeat
  await sleep(2500);
  await b.network({});
  t.ok((await b.lines(i)).includes(word), 'a burst of keys arrives exactly as typed');
  t.ok(b.requests.input <= 3, `batched: ${b.requests.input} input request(s) for ${word.length + 6} keys`);
  await b.type(i, 'exit\r');
}
