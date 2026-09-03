export const DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>TriageCI - CI failure intelligence</title>
  <style>
    :root{font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:#e8eef9;background:#08111f;color-scheme:dark}
    *{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 80% 0,#18345d 0,transparent 36%),#08111f}
    main{max-width:1120px;margin:auto;padding:42px 24px}.hero{display:flex;justify-content:space-between;gap:24px;align-items:end}
    .eyebrow{color:#6ee7f9;font-weight:800;letter-spacing:.13em;text-transform:uppercase;font-size:12px}h1{font-size:42px;margin:8px 0 5px;letter-spacing:-.04em}
    .sub{color:#9fb0c9;max-width:670px;line-height:1.5}.search{display:flex;gap:8px;margin:28px 0 22px}input{flex:1;background:#0d1a2d;border:1px solid #29405f;color:#fff;border-radius:9px;padding:13px 15px;font-size:15px}
    button{border:0;border-radius:9px;padding:0 22px;background:#6ee7f9;color:#06202b;font-weight:800;cursor:pointer}.cards{display:grid;grid-template-columns:repeat(5,1fr);gap:12px}.card,.panel{background:#0d1a2ddd;border:1px solid #203653;border-radius:13px;box-shadow:0 14px 35px #0003}
    .card{padding:17px}.label{font-size:12px;color:#91a4bf;text-transform:uppercase;letter-spacing:.08em}.value{font-size:28px;font-weight:800;margin-top:8px}.bad{color:#fb7185}.warn{color:#fbbf24}.good{color:#6ee7b7}
    .panel{margin-top:14px;padding:20px}h2{font-size:17px;margin:0 0 14px}table{width:100%;border-collapse:collapse;font-size:13px}th{text-align:left;color:#91a4bf;font-weight:600;border-bottom:1px solid #29405f;padding:10px 7px}td{padding:12px 7px;border-bottom:1px solid #182a43}code{color:#b8c9e3}.pill{padding:4px 8px;border-radius:999px;background:#33280c;color:#fcd34d;font-weight:700;font-size:11px}.empty{color:#71839d;padding:28px 0;text-align:center}@media(max-width:800px){.cards{grid-template-columns:repeat(2,1fr)}.hero{display:block}h1{font-size:34px}.tablewrap{overflow:auto}}
  </style>
</head>
<body><main>
  <div class="hero"><div><div class="eyebrow">Developer productivity</div><h1>TriageCI</h1><div class="sub">Turn noisy test reruns into evidence. Track pass/fail history, distinguish regressions from nondeterminism, and cluster repeated failures.</div></div><div class="label" id="status">READY</div></div>
  <form class="search" id="form"><input id="repo" aria-label="GitHub repository" value="demo/checkout" placeholder="owner/repository"><button>Inspect</button></form>
  <section class="cards"><div class="card"><div class="label">Runs</div><div class="value" id="runs">0</div></div><div class="card"><div class="label">Observations</div><div class="value" id="observations">0</div></div><div class="card"><div class="label">Tracked tests</div><div class="value" id="tests">0</div></div><div class="card"><div class="label">Flaky</div><div class="value warn" id="flaky">0</div></div><div class="card"><div class="label">Regressions</div><div class="value bad" id="regressions">0</div></div></section>
  <section class="panel"><h2>Highest-confidence flaky tests</h2><div class="tablewrap"><table><thead><tr><th>Test</th><th>Runs</th><th>Pass / fail</th><th>Transitions</th><th>Score</th><th>State</th></tr></thead><tbody id="rows"><tr><td colspan="6" class="empty">Ingest CI results to begin.</td></tr></tbody></table></div></section>
  <section class="panel"><h2>Recurring failure signatures</h2><div class="tablewrap"><table><thead><tr><th>Signature</th><th>Occurrences</th><th>Tests</th><th>Normalized example</th></tr></thead><tbody id="clusters"><tr><td colspan="4" class="empty">No failures recorded.</td></tr></tbody></table></div></section>
</main><script>
const $=id=>document.getElementById(id); const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function load(){const repo=$('repo').value.trim();$('status').textContent='LOADING';try{const r=await fetch('/api/v1/summary?repository='+encodeURIComponent(repo));if(!r.ok)throw new Error(await r.text());const d=await r.json();for(const k of ['runs','observations','tests','flaky','regressions'])$(k).textContent=Number(d[k]).toLocaleString();$('rows').innerHTML=d.topFlaky.length?d.topFlaky.map(x=>'<tr><td><strong>'+esc(x.name)+'</strong><br><code>'+esc(x.suite)+'</code></td><td>'+x.totalRuns+'</td><td>'+x.passes+' / '+x.failures+'</td><td>'+x.transitions+'</td><td>'+Number(x.flakeScore).toFixed(1)+'</td><td><span class="pill">'+esc(x.state)+'</span></td></tr>').join(''):'<tr><td colspan="6" class="empty">No flaky tests detected.</td></tr>';$('clusters').innerHTML=d.failureClusters.length?d.failureClusters.map(x=>'<tr><td><code>'+esc(x.signature)+'</code></td><td>'+x.occurrences+'</td><td>'+x.affectedTests+'</td><td>'+esc(String(x.example).slice(0,120))+'</td></tr>').join(''):'<tr><td colspan="4" class="empty">No failures recorded.</td></tr>';$('status').textContent='LIVE'}catch(e){$('status').textContent='ERROR';console.error(e)}}
$('form').addEventListener('submit',e=>{e.preventDefault();load()});load();setInterval(load,10000);
</script></body></html>`;
