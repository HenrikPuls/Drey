/**
 * The page the gateway serves until the phone client is built (req-66
 * R2; R3 replaces it with `dist-electron/plugins/tickets/remote/`):
 * pairing from the `#pair=` link or a typed code, then a one-line
 * summary of what waits. Plain files, no inline script — the CSP allows
 * only scripts from the gateway itself.
 */

const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Tickets">
<meta name="color-scheme" content="dark">
<title>Drey Tickets</title>
<link rel="stylesheet" href="pair.css">
<script src="pair.js" defer></script>
</head>
<body>
<main>
<h1>Drey Tickets</h1>
<p id="status">Connecting…</p>
<form id="pair" hidden>
<label for="code">Pairing code</label>
<input id="code" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" inputmode="text">
<button type="submit">Pair</button>
<p class="hint">Settings → Tickets → Remote access on the desk shows the code.</p>
</form>
</main>
</body>
</html>
`;

const PAIR_CSS = `:root { color-scheme: dark; --bg: #18191b; --bar: #222326; --line: #3b3d42; --text: #f4f5f6; --faint: #979ca2; --accent: #7aa7f0; --bad: #ee8f89; }
body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif; }
main { max-width: 420px; margin: 0 auto; padding: max(24px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) 24px max(16px, env(safe-area-inset-left)); display: flex; flex-direction: column; gap: 12px; }
h1 { font-size: 22px; margin: 0; }
form { display: flex; flex-direction: column; gap: 8px; }
label { color: var(--faint); font-size: 14px; }
input { font: 20px ui-monospace, monospace; letter-spacing: 0.1em; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--line); background: var(--bar); color: var(--text); }
button { font: 600 16px ui-sans-serif, system-ui, sans-serif; padding: 12px; border-radius: 8px; border: 0; background: var(--accent); color: #101113; min-height: 44px; }
.hint { color: var(--faint); font-size: 14px; margin: 0; }
.error { color: var(--bad); }
`;

const PAIR_JS = `(function () {
  var KEY = 'drey.remote.token';
  var status = document.getElementById('status');
  var form = document.getElementById('pair');
  var input = document.getElementById('code');
  function token() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function say(text, bad) { status.textContent = text; status.className = bad ? 'error' : ''; }
  function api(method, path, body) {
    var headers = { 'Content-Type': 'application/json' };
    var t = token();
    if (t) headers.Authorization = 'Bearer ' + t;
    return fetch(path, { method: method, headers: headers, body: body === undefined ? undefined : JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); });
  }
  function pair(code) {
    say('Pairing…');
    return api('POST', '/api/pair', { code: code }).then(function (r) {
      if (r.status !== 200 || !r.body.token) { form.hidden = false; say(r.body.error || 'Pairing failed', true); return; }
      try { localStorage.setItem(KEY, r.body.token); } catch (e) { say('This browser keeps no data — pairing cannot be stored.', true); return; }
      form.hidden = true;
      summary();
    });
  }
  function summary() {
    api('GET', '/api/me').then(function (me) {
      if (me.status === 401) { try { localStorage.removeItem(KEY); } catch (e) {} form.hidden = false; say('This device is not paired.', true); return; }
      return api('GET', '/api/needs').then(function (n) {
        var count = Array.isArray(n.body) ? n.body.length : 0;
        say('Paired as ' + me.body.device.name + '. ' + (count === 0 ? 'Nothing waits on you.' : count + (count === 1 ? ' thing waits' : ' things wait') + ' on you.') + ' The full board arrives with the next update.');
      });
    }).catch(function () { say('The desk does not answer.', true); });
  }
  form.addEventListener('submit', function (e) { e.preventDefault(); void pair(input.value); });
  var m = /^#pair=([A-Za-z0-9-]+)$/.exec(location.hash);
  if (m) { history.replaceState(null, '', location.pathname); void pair(m[1]); }
  else if (token()) { summary(); }
  else { form.hidden = false; say('Pair this device with the desk.'); }
})();
`;

export const FALLBACK_FILES: Readonly<Record<string, string>> = {
  'index.html': INDEX_HTML,
  'pair.css': PAIR_CSS,
  'pair.js': PAIR_JS,
};
