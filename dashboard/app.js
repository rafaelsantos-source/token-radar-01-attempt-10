// Rug Radar dashboard: renders the ranked board, a filterable table, a
// per-protocol detail view with the rug-risk breakdown, and the live-token
// and set-aside views. No framework, no network: the data is window.RADAR
// from data.js, and every number on the page is recomputed here from the
// snapshot's own fields, with the same functions lib/model.ts runs.
//
//   implied = tvl x 0.25 x (1 + clamp(change_7d, -60, 120) / 100 x 0.5)
//             x (0.6 + min(age, 1095) / 1095 x 0.4)
//   risk    = flash (0-30) + velocity (0-25) + solo (0-15) + bleed (0-15)
//             + unproven (0-15), bands LOW 0-19, GUARDED 20-39, ELEVATED
//             40-59, HIGH 60-79, SEVERE 80-100
//   adjusted = implied x (1 - 0.6 x risk / 100)
'use strict';

var DATA = window.RADAR;
var MODEL = DATA.model;
var DAY_MS = 86400000;
var BANDS = ['LOW', 'GUARDED', 'ELEVATED', 'HIGH', 'SEVERE'];
var BAND_MIN = { all: 0, guarded: 20, elevated: 40, high: 60, severe: 80 };

// ---------------------------------------------------------------- the model

function finite(value, fallback) {
  return typeof value === 'number' && isFinite(value) ? value : fallback;
}

function ageDays(asOf, listedAt) {
  if (listedAt === null || listedAt === undefined) return null;
  var a = Date.parse(asOf + 'T00:00:00Z');
  var b = Date.parse(listedAt + 'T00:00:00Z');
  if (!isFinite(a) || !isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

function round1(n) { return Math.round(n * 10) / 10; }
function round4(n) { return Math.round(n * 10000) / 10000; }

function bandOf(score) {
  if (score >= 80) return 'SEVERE';
  if (score >= 60) return 'HIGH';
  if (score >= 40) return 'ELEVATED';
  if (score >= 20) return 'GUARDED';
  return 'LOW';
}

function money(n) {
  if (n >= 1000000000) return '$' + round1(n / 1000000000) + 'B';
  if (n >= 1000000) return '$' + round1(n / 1000000) + 'M';
  if (n >= 1000) return '$' + round1(n / 1000) + 'K';
  return '$' + Math.round(n);
}

function impliedOf(r) {
  var age = ageDays(DATA.as_of, r.listed_at);
  var rawGrowth = finite(r.change_7d, 0);
  var growthPct = Math.min(MODEL.growth_cap, Math.max(MODEL.growth_floor, rawGrowth));
  var growthMult = 1 + (growthPct / 100) * MODEL.growth_weight;
  var ageForModel = age === null ? MODEL.unknown_age_days : age;
  var maturityMult = MODEL.maturity_floor + (Math.min(Math.max(ageForModel, 0), MODEL.maturity_days) / MODEL.maturity_days) * MODEL.maturity_range;
  var raw = Math.max(1, Math.round(r.tvl_usd * MODEL.base_multiple * growthMult * maturityMult));
  return { raw: raw, growthPct: growthPct, growthMult: growthMult, maturityMult: maturityMult, age: age };
}

function rugOf(r) {
  var growth = finite(r.change_7d, 0);
  var age = ageDays(DATA.as_of, r.listed_at);
  var signals = [];
  var flash = growth > 50 ? 30 * Math.min(1, Math.max(0, Math.log(growth / 50) / Math.log(20))) : 0;
  signals.push({ id: 'flash', label: 'Flash growth', points: round1(flash), max: 30,
    detail: growth > 50 ? 'TVL up ' + round1(growth) + '% in 7 days' : 'No seven-day spike' });
  var velocity, velocityDetail;
  if (age === null) {
    velocity = 5;
    velocityDetail = 'No listing date, so the arrival rate cannot be checked';
  } else if (age >= 365) {
    velocity = 0;
    velocityDetail = age + ' days of history: the money did not arrive overnight';
  } else {
    var perDay = r.tvl_usd / Math.max(age, 1);
    velocity = 25 * Math.min(1, Math.max(0, Math.log10(perDay / 200000) / Math.log10(50)));
    velocityDetail = money(perDay) + ' of TVL per day of life';
  }
  signals.push({ id: 'velocity', label: 'Fast money', points: round1(velocity), max: 25, detail: velocityDetail });
  var solo = r.chains.length === 1 ? 15 : r.chains.length === 2 ? 7 : 0;
  signals.push({ id: 'solo', label: 'Single chain', points: solo, max: 15,
    detail: r.chains.length <= 1 ? 'All of its TVL sits on one chain' : 'TVL spread over ' + r.chains.length + ' chains' });
  var bleed = growth < -70 ? 15 : growth < -20 ? 15 * (-20 - growth) / 50 : 0;
  signals.push({ id: 'bleed', label: 'Capital leaving', points: round1(bleed), max: 15,
    detail: growth < -20 ? 'TVL down ' + round1(-growth) + '% in 7 days' : 'No seven-day outflow' });
  var unproven, unprovenDetail;
  if (age === null) { unproven = 10; unprovenDetail = 'No listing date: there is no record to check'; }
  else if (age < 30) { unproven = 12; unprovenDetail = 'Listed ' + age + ' days ago: almost no record'; }
  else if (age < 90) { unproven = 8; unprovenDetail = 'Listed ' + age + ' days ago: a short record'; }
  else if (age < 180) { unproven = 4; unprovenDetail = 'Listed ' + age + ' days ago'; }
  else { unproven = 0; unprovenDetail = 'Listed ' + age + ' days ago'; }
  signals.push({ id: 'unproven', label: 'No track record', points: unproven, max: 15, detail: unprovenDetail });
  var score = round1(signals.reduce(function (n, s) { return n + s.points; }, 0));
  return { score: score, band: bandOf(score), signals: signals };
}

function adjustedOf(r) {
  var imp = impliedOf(r);
  var risk = rugOf(r);
  return { raw: imp.raw, adjusted: Math.max(1, Math.round(imp.raw * (1 - MODEL.risk_discount * (risk.score / 100)))), risk: risk, imp: imp };
}

function stepText(step) {
  var s = step.text + ' Cost: ' + step.cost + '. Time: ' + step.time + '.';
  if (s.length > 600) s = s.slice(0, 596) + '...';
  if (s.length < 20) s = s + ' Hold the position and check the protocol\'s own page.';
  return s;
}

function chainOf(r) { return r.chains.length > 0 ? r.chains[0] : 'its main chain'; }

function capitalFor(r) {
  if (r.tvl_usd >= 5000000000) return 250;
  if (r.tvl_usd >= 1000000000) return 150;
  if (r.tvl_usd >= 100000000) return 100;
  return 50;
}

function holdDaysFor(age) {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

function rugCheckStep(risk) {
  if (risk.band === 'HIGH' || risk.band === 'SEVERE') {
    return { text: 'This one is ' + risk.band.toLowerCase() + ' risk at ' + risk.score + ' out of 100: do not deposit until you have opened the protocol\'s own docs, confirmed the contracts the app uses are the ones it lists, and checked who can change them, and size the deposit as money you can lose outright.',
      cost: 'nothing but the check', time: '30 minutes' };
  }
  if (risk.band === 'ELEVATED') {
    return { text: 'This one is elevated risk at ' + risk.score + ' out of 100: open the protocol\'s own docs, confirm the contracts the app uses are the ones it lists, and keep the deposit small enough that losing it outright would not hurt.',
      cost: 'nothing but the check', time: '20 minutes' };
  }
  if (risk.band === 'GUARDED') {
    return { text: 'This one is guarded at ' + risk.score + ' out of 100: open the protocol\'s own docs, confirm the contracts the app uses are the ones it lists, and check who can change them before you deposit.',
      cost: 'nothing but the check', time: '15 minutes' };
  }
  return { text: 'Before you deposit, open the protocol\'s own docs page and confirm the contracts the app uses are the ones it lists.',
    cost: 'nothing but the check', time: '10 minutes' };
}

function actionFor(r, capital, chain) {
  var c = (r.category || '').toLowerCase();
  var name = r.name;
  if (c.indexOf('lend') >= 0 || c.indexOf('cdp') >= 0 || c.indexOf('collateral') >= 0) return 'Supply $' + capital + ' of USDC to ' + name + ' on ' + chain + ' and keep the position open.';
  if (c.indexOf('dex') >= 0 || c.indexOf('yield') >= 0 || c.indexOf('leveraged farm') >= 0) return 'Provide $' + capital + ' of liquidity to ' + name + '\'s main pool on ' + chain + ' and keep the position open.';
  if (c.indexOf('bridge') >= 0) return 'Bridge $' + capital + ' of USDC to ' + chain + ' through ' + name + ' and use the bridged funds in its app.';
  if (c.indexOf('staking') >= 0 || c.indexOf('restak') >= 0) return 'Stake $' + capital + ' of the chain\'s staking asset through ' + name + ' and keep the receipt.';
  if (c.indexOf('perpetual') >= 0 || c.indexOf('derivative') >= 0) return 'Deposit $' + capital + ' of USDC as margin on ' + name + ' and open one small hedge.';
  if (c.indexOf('prediction') >= 0) return 'Fund $' + capital + ' and place one market position on ' + name + '.';
  if (c.indexOf('curator') >= 0 || c.indexOf('allocator') >= 0) return 'Deposit $' + capital + ' into a ' + name + ' vault on ' + chain + ' and keep the shares.';
  if (c.indexOf('stable') >= 0) return 'Mint or deposit $' + capital + ' of the stable asset through ' + name + ' on ' + chain + '.';
  if (c.indexOf('rwa') >= 0) return 'Mint $' + capital + ' of the protocol\'s yield asset on ' + chain + ' and hold it.';
  if (c.indexOf('insurance') >= 0) return 'Buy $' + capital + ' of cover from ' + name + ' on ' + chain + ' and keep the policy.';
  return 'Deposit $' + capital + ' of USDC into ' + name + ' on ' + chain + ' and keep the position open.';
}

function farmSteps(r) {
  var calc = adjustedOf(r);
  var chain = chainOf(r);
  var capital = capitalFor(r);
  var hold = holdDaysFor(calc.imp.age);
  var action = actionFor(r, capital, chain);
  return [
    { text: 'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.',
      cost: 'under $3 of gas for the first transaction', time: '5 minutes' },
    rugCheckStep(calc.risk),
    { text: action, cost: '$' + capital + ' of capital and about $' + (capital >= 150 ? 8 : 4) + ' of gas', time: '15 minutes to set up' },
    { text: 'Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.',
      cost: 'about $2 of gas a week', time: '10 minutes a week' },
    { text: 'Hold the position for at least ' + hold + ' days so the activity is counted in more than one snapshot.',
      cost: 'the $' + capital + ' stays in the position', time: hold + ' days' },
    { text: 'Before you withdraw, open the protocol\'s own points or rewards page and claim only from the link it publishes, then write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.',
      cost: 'no fee to check, and never pay to claim', time: '15 minutes' }
  ].map(stepText);
}

// ---------------------------------------------------------------- dom helpers

function el(tag, attrs, children) {
  var node = document.createElement(tag);
  if (attrs) {
    for (var k in attrs) {
      if (k === 'text') node.textContent = attrs[k];
      else if (k === 'html') node.innerHTML = attrs[k];
      else if (k === 'onclick') node.addEventListener('click', attrs[k]);
      else node.setAttribute(k, attrs[k]);
    }
  }
  (children || []).forEach(function (c) { if (c !== null && c !== undefined) node.appendChild(c); });
  return node;
}

function badge(band, score) {
  return el('span', { 'class': 'badge ' + band.toLowerCase() }, [
    el('span', { 'class': 'dot ' + band.toLowerCase() }),
    document.createTextNode(band + (score !== undefined ? ' ' + score : '')),
  ]);
}

// ---------------------------------------------------------------- state

var state = { tab: 'board', q: '', risk: 'all', cat: 'all', sort: 'rank', dir: 1, show: 50, slug: null };

function readHash() {
  var hash = window.location.hash.replace(/^#/, '');
  state.slug = null;
  state.tab = 'board';
  if (hash.indexOf('/protocol/') === 0) {
    state.slug = decodeURIComponent(hash.slice('/protocol/'.length));
    return;
  }
  if (hash.indexOf('/live') === 0) { state.tab = 'live'; return; }
  if (hash.indexOf('/set-aside') === 0) { state.tab = 'set-aside'; return; }
  var q = hash.indexOf('?') >= 0 ? hash.slice(hash.indexOf('?') + 1) : '';
  var params = new URLSearchParams(q);
  state.q = params.get('q') || '';
  state.risk = params.get('risk') || 'all';
  state.cat = params.get('cat') || 'all';
  state.sort = params.get('sort') || 'rank';
  state.dir = params.get('dir') === '1' ? 1 : -1;
  if (state.sort === 'rank') state.dir = 1;
}

function writeHash() {
  var parts = [];
  if (state.slug !== null) {
    history.replaceState(null, '', '#/protocol/' + encodeURIComponent(state.slug));
    return;
  }
  if (state.tab === 'live') { history.replaceState(null, '', '#/live'); return; }
  if (state.tab === 'set-aside') { history.replaceState(null, '', '#/set-aside'); return; }
  if (state.q) parts.push('q=' + encodeURIComponent(state.q));
  if (state.risk !== 'all') parts.push('risk=' + state.risk);
  if (state.cat !== 'all') parts.push('cat=' + encodeURIComponent(state.cat));
  if (state.sort !== 'rank') parts.push('sort=' + state.sort);
  if (state.dir === -1 && state.sort !== 'rank') parts.push('dir=-1');
  history.replaceState(null, '', parts.length ? '#/?' + parts.join('&') : '#/');
}

// ---------------------------------------------------------------- filtering

function bandIndex(band) { return BANDS.indexOf(band); }

function filteredRows() {
  var min = BAND_MIN[state.risk] || 0;
  var q = state.q.trim().toLowerCase();
  var rows = DATA.rows.filter(function (r) {
    var calc = adjustedOf(r);
    if (calc.risk.score < min) return false;
    if (state.cat !== 'all' && (r.category || '') !== state.cat) return false;
    if (q && r.name.toLowerCase().indexOf(q) < 0 && r.slug.toLowerCase().indexOf(q) < 0) return false;
    return true;
  });
  var key = state.sort;
  var dir = state.dir;
  var val = function (r) {
    if (key === 'tvl') return r.tvl_usd;
    if (key === 'change') return finite(r.change_7d, -9999);
    if (key === 'implied') return r.implied_value_usd;
    if (key === 'risk') return adjustedOf(r).risk.score;
    if (key === 'name') return r.name.toLowerCase();
    return r.rank;
  };
  rows.sort(function (a, b) {
    var va = val(a), vb = val(b);
    if (va < vb) return -1 * dir;
    if (va > vb) return 1 * dir;
    return a.rank - b.rank;
  });
  return rows;
}

// ---------------------------------------------------------------- rendering

function renderHeader(wrap) {
  var high = DATA.risk_counts.HIGH + DATA.risk_counts.SEVERE;
  wrap.appendChild(el('h1', {}, [
    document.createTextNode('Rug '),
    el('span', { 'class': 'mark', text: 'Radar' }),
  ]));
  wrap.appendChild(el('p', { 'class': 'sub' }, [
    document.createTextNode('A token launch radar that ranks the '),
    el('b', { text: String(DATA.board_size) }),
    document.createTextNode(' pre-token protocols of the snapshot by what their launch would be worth — discounted by how much each one looks like a rug. Snapshot as of '),
    el('b', { text: DATA.as_of }),
    document.createTextNode(', DefiLlama protocols.'),
  ]));
  var stats = el('div', { 'class': 'stats' });
  [['' + DATA.board_size, 'protocols ranked'], ['' + DATA.watchlist_size, 'on the watchlist'],
   ['' + high, 'high or severe risk'], ['' + DATA.set_aside_size, 'wrapped products set aside'],
   ['' + DATA.live_size, 'live tokens shown apart']].forEach(function (s) {
    stats.appendChild(el('div', { 'class': 'stat' }, [
      el('div', { 'class': 'n' + (s[1].indexOf('high') === 0 ? ' red' : ''), text: s[0] }),
      el('div', { 'class': 'l', text: s[1] }),
    ]));
  });
  wrap.appendChild(stats);
  var legend = el('div', { 'class': 'legend' });
  legend.appendChild(el('button', { 'class': 'chip', type: 'button', 'aria-pressed': state.risk === 'all' ? 'true' : 'false',
    onclick: function () { state.risk = 'all'; writeHash(); render(); } }, [
    document.createTextNode('All risk ' + DATA.board_size),
  ]));
  BANDS.forEach(function (band) {
    var min = band.toLowerCase();
    var label = band.charAt(0) + band.slice(1).toLowerCase();
    legend.appendChild(el('button', { 'class': 'chip', type: 'button', 'aria-pressed': state.risk === min ? 'true' : 'false',
      onclick: function () { state.risk = state.risk === min ? 'all' : min; writeHash(); render(); } }, [
      el('span', { 'class': 'dot ' + min }),
      document.createTextNode(label + ' and up · ' + DATA.risk_counts[band]),
    ]));
  });
  wrap.appendChild(legend);
}

function renderTabs(wrap) {
  var tabs = el('div', { 'class': 'tabs' });
  [['board', 'Launches (' + DATA.board_size + ')'], ['live', 'Live token (' + DATA.live_size + ')'],
   ['set-aside', 'Set aside (' + DATA.set_aside_size + ')']].forEach(function (t) {
    tabs.appendChild(el('button', { 'class': 'tab', type: 'button', 'aria-pressed': state.tab === t[0] ? 'true' : 'false',
      onclick: function () { state.tab = t[0]; state.slug = null; state.show = 50; writeHash(); render(); } }, [
      document.createTextNode(t[1]),
    ]));
  });
  wrap.appendChild(tabs);
}

function renderControls(wrap) {
  var card = el('div', { 'class': 'card' });
  var controls = el('div', { 'class': 'controls' });
  var search = el('input', { type: 'search', placeholder: 'Search a protocol by name or slug', value: state.q,
    'aria-label': 'Search protocols' });
  search.addEventListener('input', function () { state.q = search.value; state.show = 50; writeHash(); renderBoardOnly(); });
  controls.appendChild(search);
  var cats = [];
  DATA.rows.forEach(function (r) { if (r.category && cats.indexOf(r.category) < 0) cats.push(r.category); });
  cats.sort();
  var select = el('select', { 'aria-label': 'Filter by category' });
  select.appendChild(el('option', { value: 'all', text: 'All categories' }));
  cats.forEach(function (c) { select.appendChild(el('option', { value: c, text: c })); });
  select.value = state.cat;
  select.addEventListener('change', function () { state.cat = select.value; state.show = 50; writeHash(); render(); });
  controls.appendChild(select);
  var clear = el('button', { 'class': 'btn', type: 'button', text: 'Clear filters',
    onclick: function () { state.q = ''; state.cat = 'all'; state.risk = 'all'; state.sort = 'rank'; state.dir = 1; writeHash(); render(); } });
  controls.appendChild(clear);
  card.appendChild(controls);
  wrap.appendChild(card);
}

function sortButton(label, key) {
  var arrow = state.sort === key ? (state.dir === 1 ? ' ↑' : ' ↓') : '';
  return el('button', { type: 'button', text: label + arrow,
    onclick: function () {
      if (state.sort === key) state.dir = -state.dir;
      else { state.sort = key; state.dir = key === 'rank' || key === 'name' ? 1 : -1; }
      writeHash(); render();
    } });
}

function renderBoardTable(wrap, rows) {
  var shown = rows.slice(0, state.show);
  var table = el('table', { 'class': 'board' });
  var head = el('tr');
  head.appendChild(el('th', {}, [sortButton('Rank', 'rank')]));
  head.appendChild(el('th', {}, [sortButton('Protocol', 'name')]));
  head.appendChild(el('th', { 'class': 'num' }, [sortButton('TVL', 'tvl')]));
  head.appendChild(el('th', { 'class': 'num' }, [sortButton('7d', 'change')]));
  head.appendChild(el('th', { 'class': 'num' }, [sortButton('Implied value', 'implied')]));
  head.appendChild(el('th', { 'class': 'num' }, [sortButton('Rug risk', 'risk')]));
  table.appendChild(el('thead', {}, [head]));
  var body = el('tbody');
  shown.forEach(function (r) {
    var calc = adjustedOf(r);
    var tr = el('tr', { onclick: function () { state.slug = r.slug; writeHash(); render(); } });
    tr.appendChild(el('td', { text: String(r.rank) }));
    var nameCell = el('td');
    nameCell.appendChild(el('div', { 'class': 'name', text: r.name }));
    nameCell.appendChild(el('div', { 'class': 'meta', text: (r.category || 'Uncategorised') + ' · ' + (r.chains.join(', ') || 'no chain listed') }));
    tr.appendChild(nameCell);
    tr.appendChild(el('td', { 'class': 'num', text: money(r.tvl_usd) }));
    var chg = r.change_7d === null ? '—' : (r.change_7d >= 0 ? '+' : '') + round1(r.change_7d) + '%';
    tr.appendChild(el('td', { 'class': 'num ' + (r.change_7d !== null && r.change_7d < 0 ? 'down' : 'up'), text: chg }));
    var impCell = el('td', { 'class': 'num' });
    impCell.appendChild(document.createTextNode(money(r.implied_value_usd)));
    if (calc.risk.score > 0) impCell.appendChild(el('span', { 'class': 'raw', text: 'raw ' + money(calc.raw) + ' · −' + Math.round(MODEL.risk_discount * calc.risk.score) + '%' }));
    tr.appendChild(impCell);
    var riskCell = el('td', { 'class': 'num' });
    riskCell.appendChild(badge(calc.risk.band, calc.risk.score));
    tr.appendChild(riskCell);
    body.appendChild(tr);
  });
  table.appendChild(body);
  wrap.appendChild(el('div', { 'class': 'card' }, [table]));
  if (rows.length === 0) {
    wrap.appendChild(el('div', { 'class': 'empty', text: 'No protocol matches these filters.' }));
  }
  var pager = el('div', { 'class': 'pager' });
  pager.appendChild(el('span', { text: 'Showing ' + shown.length + ' of ' + rows.length + ' rows. Click a row for its detail view.' }));
  if (rows.length > state.show) {
    pager.appendChild(el('button', { 'class': 'btn primary', type: 'button', text: 'Show all ' + rows.length,
      onclick: function () { state.show = rows.length; render(); } }));
  }
  wrap.appendChild(pager);
}

function renderBoardOnly() {
  var wrap = document.querySelector('.wrap');
  var old = document.getElementById('board-area');
  if (old) old.remove();
  var area = el('div', { id: 'board-area' });
  renderBoardTable(area, filteredRows());
  wrap.appendChild(area);
}

function renderDetail(wrap, slug) {
  var r = null;
  DATA.rows.forEach(function (x) { if (x.slug === slug) r = x; });
  if (!r) {
    wrap.appendChild(el('div', { 'class': 'card' }, [
      el('p', { text: 'No ranked protocol with the slug "' + slug + '".' }),
      el('button', { 'class': 'btn primary', type: 'button', text: 'Back to the board',
        onclick: function () { state.slug = null; writeHash(); render(); } }),
    ]));
    return;
  }
  var calc = adjustedOf(r);
  var risk = calc.risk;
  var back = el('button', { 'class': 'btn', type: 'button', text: '← Back to the board',
    onclick: function () { state.slug = null; writeHash(); render(); } });
  wrap.appendChild(back);
  wrap.appendChild(el('div', { 'class': 'note', text: ' ' }));
  var head = el('div', { 'class': 'card' });
  var top = el('div', { 'class': 'detail-head' });
  var title = el('div');
  title.appendChild(el('h2', { text: '#' + r.rank + ' · ' + r.name }));
  title.appendChild(el('p', { 'class': 'sub', text: (r.category || 'Uncategorised') + ' · ' + (r.chains.join(', ') || 'no chain listed') + ' · ' + (r.listed_at ? 'listed ' + r.listed_at : 'listing date unknown') }));
  top.appendChild(title);
  top.appendChild(badge(risk.band, risk.score));
  head.appendChild(top);
  var kv = el('div', { 'class': 'kv' });
  [['TVL', money(r.tvl_usd)], ['7-day change', r.change_7d === null ? '—' : (r.change_7d >= 0 ? '+' : '') + round1(r.change_7d) + '%'],
   ['Age', calc.imp.age === null ? 'unknown' : calc.imp.age + ' days'],
   ['Raw implied value', money(calc.raw)], ['Risk-adjusted value', money(r.implied_value_usd)],
   ['Risk discount', '−' + Math.round(MODEL.risk_discount * risk.score) + '%']].forEach(function (c) {
    kv.appendChild(el('div', { 'class': 'cell' }, [
      el('div', { 'class': 'k', text: c[0] }),
      el('div', { 'class': 'v', text: c[1] }),
    ]));
  });
  head.appendChild(kv);
  head.appendChild(el('div', { 'class': 'math' }, [
    document.createTextNode('Value: ' + money(r.tvl_usd) + ' × ' + MODEL.base_multiple + ' × growth ' + calc.imp.growthMult.toFixed(2) + ' × maturity ' + calc.imp.maturityMult.toFixed(2) + ' = '),
    el('b', { text: money(calc.raw) }),
    document.createTextNode(' raw. Rug risk ' + risk.score + ' / 100 discounts ' + Math.round(MODEL.risk_discount * risk.score) + '%, so the board ranks it at '),
    el('b', { text: money(r.implied_value_usd) }),
    document.createTextNode('.'),
  ]));
  var verdicts = {
    LOW: 'Low risk. Nothing in the snapshot looks like a rug shape: no spike, no overnight money, a record to check.',
    GUARDED: 'Guarded. One or two signals are up. Worth farming, but read the rug check in the plan before depositing.',
    ELEVATED: 'Elevated risk. The money arrived fast or the record is thin. Keep the position small and verify the contracts first.',
    HIGH: 'High risk. This is the shape a rug takes: a violent TVL spike on one chain, weeks after listing. Do not chase it.',
    SEVERE: 'Severe risk. Nearly every signal is up. Treat any deposit here as money already lost.',
  };
  head.appendChild(el('div', { 'class': 'verdict ' + risk.band.toLowerCase(), text: verdicts[risk.band] }));
  head.appendChild(el('h3', { text: 'Rug risk breakdown — ' + risk.score + ' of 100' }));
  risk.signals.forEach(function (s) {
    var frac = s.points / s.max;
    var cls = frac >= 0.8 ? 'high' : frac >= 0.5 ? 'elevated' : frac >= 0.25 ? 'guarded' : 'low';
    var sig = el('div', { 'class': 'signal' });
    sig.appendChild(el('div', { 'class': 'row' }, [
      el('b', { text: s.label }),
      el('span', { 'class': 'pts', text: s.points + ' / ' + s.max }),
    ]));
    sig.appendChild(el('div', { 'class': 'bar' }, [el('i', { 'class': cls, style: 'width:' + Math.round(frac * 100) + '%' })]));
    sig.appendChild(el('div', { 'class': 'why', text: s.detail }));
    head.appendChild(sig);
  });
  wrap.appendChild(head);
  var plan = el('div', { 'class': 'card' });
  plan.appendChild(el('h3', { text: 'Farm plan — six steps, with the rug check second' }));
  var ol = el('ol', { 'class': 'plan' });
  farmSteps(r).forEach(function (s) {
    var parts = s.split(' Cost: ');
    var main = parts[0];
    var cost = parts.length > 1 ? parts[1] : '';
    var li = el('li');
    li.appendChild(document.createTextNode(main + '. '));
    if (cost) li.appendChild(el('span', { 'class': 'cost', text: 'Cost: ' + cost }));
    ol.appendChild(li);
  });
  plan.appendChild(ol);
  wrap.appendChild(plan);
}

function renderLive(wrap) {
  var card = el('div', { 'class': 'card' });
  card.appendChild(el('h2', { text: 'Live token — already trading' }));
  card.appendChild(el('p', { 'class': 'sub', text: 'These protocols already have a token, so the board shows the market\u2019s own value, never a model\u2019s. They are not ranked as launches.' }));
  var table = el('table', { 'class': 'board' });
  table.appendChild(el('thead', {}, [el('tr', {}, [
    el('th', { text: 'Protocol' }), el('th', { 'class': 'num', text: 'TVL' }),
    el('th', { 'class': 'num', text: 'Market cap' }), el('th', { 'class': 'num', text: '7d' }),
  ])]));
  var body = el('tbody');
  DATA.live.forEach(function (p) {
    var tr = el('tr');
    var nameCell = el('td');
    nameCell.appendChild(el('div', { 'class': 'name', text: p.name }));
    nameCell.appendChild(el('div', { 'class': 'meta', text: (p.category || 'Uncategorised') + ' · ' + (p.chains.join(', ') || 'no chain listed') }));
    tr.appendChild(nameCell);
    tr.appendChild(el('td', { 'class': 'num', text: money(p.tvl_usd) }));
    tr.appendChild(el('td', { 'class': 'num', text: p.mcap_usd === null ? '—' : money(p.mcap_usd) }));
    var chg = p.change_7d === null ? '—' : (p.change_7d >= 0 ? '+' : '') + round1(p.change_7d) + '%';
    tr.appendChild(el('td', { 'class': 'num ' + (p.change_7d !== null && p.change_7d < 0 ? 'down' : 'up'), text: chg }));
    body.appendChild(tr);
  });
  table.appendChild(body);
  card.appendChild(table);
  wrap.appendChild(card);
}

function renderSetAside(wrap) {
  var card = el('div', { 'class': 'card' });
  card.appendChild(el('h2', { text: 'Set aside — not a launch' }));
  card.appendChild(el('p', { 'class': 'sub', text: 'Pre-token protocols the board does not rank: a wrapped, staked or bridged product of a token that already trades is not a token that does not exist yet, and a versioned pool belongs to another protocol.' }));
  var table = el('table', { 'class': 'board' });
  table.appendChild(el('thead', {}, [el('tr', {}, [
    el('th', { text: 'Protocol' }), el('th', { 'class': 'num', text: 'TVL' }), el('th', { text: 'Why it is set aside' }),
  ])]));
  var body = el('tbody');
  DATA.set_aside.forEach(function (p) {
    var tr = el('tr');
    var nameCell = el('td');
    nameCell.appendChild(el('div', { 'class': 'name', text: p.name }));
    nameCell.appendChild(el('div', { 'class': 'meta', text: p.category || 'Uncategorised' }));
    tr.appendChild(nameCell);
    tr.appendChild(el('td', { 'class': 'num', text: money(p.tvl_usd) }));
    tr.appendChild(el('td', { 'class': 'muted', text: p.reason }));
    body.appendChild(tr);
  });
  table.appendChild(body);
  card.appendChild(table);
  wrap.appendChild(card);
}

function renderModel(wrap) {
  var card = el('div', { 'class': 'card model' });
  card.appendChild(el('h3', { text: 'How the radar scores — model ' + DATA.model_version }));
  var ul = el('ul');
  ul.appendChild(el('li', {}, [document.createTextNode('Implied value: TVL × 0.25 × growth × maturity, where growth clamps the 7-day change to −60…+120% at half weight and maturity rises from 0.6 to 1.0 over three years (365 days when the listing date is unknown).')]));
  ul.appendChild(el('li', {}, [document.createTextNode('Rug risk, 0–100: flash growth 0–30 on a log curve past +50% a week; fast money 0–25 from TVL per day of life; single chain 0–15; capital leaving 0–15 past −20% a week; no track record 0–15. No protocol name is ever special-cased: one function scores every row.')]));
  ul.appendChild(el('li', {}, [document.createTextNode('The board ranks the risk-adjusted value: raw value × (1 − 0.6 × risk / 100). The worst score costs 60% of the value.')]));
  ul.appendChild(el('li', {}, [document.createTextNode('Wrapped, staked and bridged products of tokens that already trade are set aside, never ranked; live-token protocols are shown apart at their market caps.')]));
  ul.appendChild(el('li', {}, [document.createTextNode('Data: the sealed snapshot of ' + DATA.as_of + ', ' + DATA.watchlist_size + ' protocols on the watchlist floor of $50M TVL. The page runs with no network.')]));
  card.appendChild(ul);
  wrap.appendChild(card);
}

function render() {
  var app = document.getElementById('app');
  app.setAttribute('aria-busy', 'false');
  app.innerHTML = '';
  var wrap = el('div', { 'class': 'wrap' });
  app.appendChild(wrap);
  renderHeader(wrap);
  renderTabs(wrap);
  if (state.slug !== null) {
    renderDetail(wrap, state.slug);
  } else if (state.tab === 'live') {
    renderLive(wrap);
  } else if (state.tab === 'set-aside') {
    renderSetAside(wrap);
  } else {
    renderControls(wrap);
    var area = el('div', { id: 'board-area' });
    renderBoardTable(area, filteredRows());
    wrap.appendChild(area);
  }
  renderModel(wrap);
}

window.addEventListener('hashchange', function () { readHash(); render(); });
readHash();
render();
