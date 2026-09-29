// Source of truth for .github/smoke/probe.mjs in bellowsai/bellows-releases.
// Used by smoke-test.yml there; see that file for why.
//
// Looks inside an installed, running Bellows through the DevTools port it was
// started with (--remote-debugging-port=9222), the way a person would look at
// the window: did it appear, did start-up finish, which version is it, what
// does it say about updates, has it logged any errors. Saves a screenshot of
// the real window.
//
//   node probe.mjs --label mac --out out [--version 1.11.4]
//                  [--update ready|available|current] [--update-wait 240] [--install]
//
// Exits non-zero on anything a user would notice. No dependencies: Node 24
// has fetch and WebSocket built in.

import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf('--' + name);
  if (i === -1) return fallback;
  const next = argv[i + 1];
  return next === undefined || next.startsWith('--') ? true : next;
};
const label = opt('label', 'app');
const out = opt('out', 'out');
const wantVersion = opt('version', null);
const wantUpdate = opt('update', null);
const updateWait = Number(opt('update-wait', 240)) * 1000;
const install = opt('install', false) === true;

fs.mkdirSync(out, { recursive: true });
const result = { label, ok: false, checks: [] };
const check = (name, ok, detail) => {
  result.checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))}`);
  return ok;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const finish = (code) => {
  result.ok = result.checks.every((c) => c.ok);
  fs.writeFileSync(path.join(out, `${label}.json`), JSON.stringify(result, null, 2));
  process.exit(code === undefined ? (result.ok ? 0 : 1) : code);
};

// 1. A window appears. The page target shows up once index.html is loading.
let target = null;
const appearBy = Date.now() + 90_000;
while (!target && Date.now() < appearBy) {
  try {
    const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
    target = list.find((t) => t.type === 'page' && /index\.html/.test(t.url)) || null;
  } catch { /* not listening yet */ }
  if (!target) await sleep(1000);
}
if (!check('window appeared', !!target, target ? undefined : 'no page on the DevTools port within 90s')) finish();

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('DevTools socket failed')); });
let seq = 0;
const pending = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
};
const send = (method, params = {}) => new Promise((resolve) => {
  const id = ++seq;
  pending.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.error) throw new Error(r.error.message);
  if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
  return r.result.result.value;
};
const shot = async (name) => {
  try {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    if (r.result?.data) fs.writeFileSync(path.join(out, `${label}-${name}.png`), Buffer.from(r.result.data, 'base64'));
  } catch { /* a screenshot is evidence, not a check */ }
};

// 2. Start-up finishes: the bridge is there and the page has drawn something.
let started = false;
const startBy = Date.now() + 60_000;
while (!started && Date.now() < startBy) {
  try {
    started = await evaluate(`document.readyState === 'complete' && typeof window.cs === 'object' && document.body.innerText.trim().length > 0`);
  } catch { /* page still loading */ }
  if (!started) await sleep(1000);
}
check('start-up finished', started, started ? undefined : 'bridge missing or page blank after 60s');
await sleep(3000);
await shot('window');

const info = await evaluate('window.cs.app.info()').catch((e) => ({ error: String(e.message) }));
result.info = info;
check('reports its version', !!info?.version, info);
if (wantVersion) check(`version is ${wantVersion}`, info?.version === wantVersion, info?.version);
check('window visible', await evaluate(`document.visibilityState`).catch(() => 'unknown') === 'visible');

// 3. Updates. Polled, because the first check is 8s after launch and a
// download can take a while.
if (wantUpdate) {
  let status = null;
  const by = Date.now() + updateWait;
  while (Date.now() < by) {
    status = await evaluate('window.cs.updates.status()').catch((e) => ({ status: 'probe-error', error: String(e.message) }));
    if (status?.status === wantUpdate || status?.status === 'error') break;
    await sleep(3000);
  }
  result.update = status;
  check(`update status reaches '${wantUpdate}'`, status?.status === wantUpdate, {
    status: status?.status, version: status?.info?.version, signature: status?.signature, manual: status?.manual, error: status?.error,
  });
  await shot('update');
}

// 4. Nothing logged as an error on the way.
const errors = await evaluate('window.cs.errors.list()').catch((e) => [{ message: 'could not read: ' + e.message }]);
result.errors = errors;
check('no errors logged', !errors || errors.length === 0, errors && errors.length ? errors.map((e) => e.message).slice(0, 5) : undefined);

// 5. Optionally, take the update. The app quits here, so this is last.
if (install && result.checks.every((c) => c.ok)) {
  send('Runtime.evaluate', { expression: 'window.cs.updates.install()' });
  await sleep(1500);
  check('install requested', true);
}
finish();
