/* Pull the live physics constants out of the running game, once, so the offline
 * tools simulate with the same numbers the browser does. Writes
 * data/physics-<game>.json. Re-run it if game.js's CONFIG block changes.
 *
 * Usage:  node tools/dump-config.js [--game=8ball] [--port=8099]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { connect, send, evalJS, sleep } = require('./cdp.js');

const arg = (k, d) => {
  const hit = process.argv.find(a => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};
const PORT = +arg('port', 8099);

(async () => {
  await connect(9222);
  await send('Runtime.enable');
  const dir = path.join(__dirname, '..', 'data');
  fs.mkdirSync(dir, { recursive: true });

  for (const game of ['8ball', '9ball', 'snooker']) {
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?autostart&dbg&nocpu&game=${game}` });
    await sleep(3200);
    const cfg = await evalJS('return window.PoolMatch.physics()');
    const out = path.join(dir, `physics-${game}.json`);
    fs.writeFileSync(out, JSON.stringify(cfg, null, 2));
    console.log(`${game.padEnd(8)} R=${cfg.R.toFixed(5)} PH=${cfg.PH.toFixed(5)} ` +
      `MAX_V=${cfg.MAX_V} pockets=${cfg.POCKETS.length} -> ${path.relative(process.cwd(), out)}`);
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
