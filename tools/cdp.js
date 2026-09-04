/* Minimal Chrome DevTools Protocol driver, shared by the tools in this folder.
 *
 * Node 22+ has a global WebSocket, so talking to Chrome needs no dependency at
 * all — which keeps this in line with the rest of the project.
 *
 * Usage: serve the game (`npm start`) and launch Chrome with
 *   --headless=new --remote-debugging-port=9222 --disable-gpu
 *   --use-angle=swiftshader --no-first-run --user-data-dir=<some tmp dir>
 * then connect(9222) and drive the page with evalJS().
 */
'use strict';

let seq = 0, ws = null;
const pending = new Map();
const listeners = [];

async function connect(port = 9222, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = list.find(t => t.type === 'page');
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
        ws.onmessage = e => {
          const m = JSON.parse(e.data);
          if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
          else if (m.method) for (const fn of listeners) fn(m);
        };
        return;
      }
    } catch { /* Chrome still booting */ }
    await sleep(250);
  }
  throw new Error(`no CDP page on port ${port} — is headless Chrome running?`);
}

function send(method, params) {
  const id = ++seq;
  return new Promise(res => {
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

/* Run an expression in the page and return its JSON value. The body is wrapped
   in a function, so use `return` for the result and `await` freely. */
async function evalJS(expr) {
  const r = await send('Runtime.evaluate', {
    expression: `(async function(){${expr}})()`,
    returnByValue: true,
    awaitPromise: true,
  });
  const res = r.result || {};
  if (res.exceptionDetails) {
    const d = res.exceptionDetails;
    throw new Error('page error: ' + ((d.exception && d.exception.description) || d.text));
  }
  return res.result ? res.result.value : undefined;
}

function onEvent(fn) { listeners.push(fn); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* Collect page errors into an array. Third-party asset 404s (analytics, fonts)
   are not the game's problem and are filtered out. */
function watchErrors(out) {
  onEvent(m => {
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      out.push('EXCEPTION: ' + ((d.exception && d.exception.description) || d.text));
    } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      out.push('console.error: ' + m.params.args.map(a => a.description || a.value).join(' '));
    } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      const e = m.params.entry;
      if (!/gsi\/client|cloudflareinsights|favicon|socket\.io/.test(e.text + (e.url || ''))) {
        out.push('log: ' + e.text);
      }
    }
  });
}

module.exports = { connect, send, evalJS, onEvent, sleep, watchErrors };
