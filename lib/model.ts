// Rug Radar: a token launch radar that ranks pre-token protocols by what their
// launch would be worth, discounted by how much they look like a rug.
//
// The board's job is the same as any launch radar's — find protocols whose
// token does not exist yet and rank them by an implied value — but the ranking
// here is risk-adjusted: a protocol whose TVL arrived overnight, on one chain,
// with no history to check, is worth less than the same TVL in a protocol that
// has run for years. Five signals, every one computed from the snapshot's own
// fields, no protocol name ever special-cased:
//
//   flash     (0-30)  the seven-day TVL spike: a 45x week is a pump shape
//   velocity  (0-25)  TVL per day of life: half a billion in 45 days is fast money
//   solo      (0-15)  one chain only: one exit, one place for the money to leave
//   bleed     (0-15)  TVL already leaving over seven days
//   unproven  (0-15)  no listing date, or listed so recently there is no record
//
// risk = flash + velocity + solo + bleed + unproven, 0 to 100, in bands
// LOW 0-19, GUARDED 20-39, ELEVATED 40-59, HIGH 60-79, SEVERE 80-100.
// adjusted = raw implied value x (1 - 0.6 x risk/100): the worst score costs
// 60% of the value. The board sorts by the adjusted value.
//
// A wrapped, staked or bridged product of a token that already trades is not
// a launch: WBTC is Bitcoin on Ethereum, a staked-ETH product is ETH in a
// staking wrapper, and neither is a protocol still waiting on a token of its
// own. Those protocols are set aside with their reason, never ranked, and the
// live-token protocols are shown apart with the market's own values.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The base value model's constants: the house model's, stated and changeable. */
export interface ModelConstants {
  base_multiple: number;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  risk_discount: number;
}

export const MODEL: ModelConstants = {
  base_multiple: 0.25,
  growth_weight: 0.5,
  growth_floor: -60,
  growth_cap: 120,
  maturity_floor: 0.6,
  maturity_range: 0.4,
  maturity_days: 1095,
  unknown_age_days: 365,
  risk_discount: 0.6,
};

/** The model's version label: the dashboard names it and the rules quote it. */
export const MODEL_VERSION = 'rug-radar-1';

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** One rug signal's contribution: its id, its plain label, its points and its cap. */
export interface RiskSignal {
  id: 'flash' | 'velocity' | 'solo' | 'bleed' | 'unproven';
  label: string;
  points: number;
  max: number;
  detail: string;
}

/** A protocol's rug risk: the score, its band and the five signals behind it. */
export interface RugRisk {
  score: number;
  band: 'LOW' | 'GUARDED' | 'ELEVATED' | 'HIGH' | 'SEVERE';
  signals: RiskSignal[];
}

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  raw_implied_value_usd: number;
  rug_risk: RugRisk;
  model: {
    base_multiple: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    risk_discount: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one row, with farm plans generated in the page. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  raw_implied_value_usd: number;
  rug_score: number;
  rug_band: RugRisk['band'];
  rug_signals: { id: RiskSignal['id']; points: number }[];
  growth_multiplier: number;
  maturity_multiplier: number;
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** A pre-token protocol set aside from the ranking, with the reason it is not a launch. */
export interface SetAsideRow {
  slug: string;
  name: string;
  category: string | null;
  tvl_usd: number;
  reason: string;
}

/** Everything the dashboard needs: the board, the live set, the set-aside set, and the model it runs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  live_size: number;
  set_aside_size: number;
  risk_counts: Record<RugRisk['band'], number>;
  rows: RadarRow[];
  live: LiveRow[];
  set_aside: SetAsideRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The three multipliers and the raw implied value one protocol gets under `model`. */
export function impliedValue(protocol: SnapshotProtocol, asOf: string, model: ModelConstants): { implied: number; growthPct: number; growthMult: number; maturityMult: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const rawGrowth = finite(protocol.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult = model.maturity_floor + (Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
  const base = protocol.tvl_usd * model.base_multiple;
  const implied = Math.max(1, Math.round(base * growthMult * maturityMult));
  return { implied, growthPct, growthMult, maturityMult, age };
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** The band a rug score falls in. */
export function bandOf(score: number): RugRisk['band'] {
  if (score >= 80) return 'SEVERE';
  if (score >= 60) return 'HIGH';
  if (score >= 40) return 'ELEVATED';
  if (score >= 20) return 'GUARDED';
  return 'LOW';
}

/** A money figure with the right unit, for a signal's detail line. */
function money(n: number): string {
  if (n >= 1_000_000_000) return `$${round1(n / 1_000_000_000)}B`;
  if (n >= 1_000_000) return `$${round1(n / 1_000_000)}M`;
  if (n >= 1_000) return `$${round1(n / 1_000)}K`;
  return `$${Math.round(n)}`;
}

/**
 * A protocol's rug risk: five signals off the snapshot's own fields. Flash
 * grows on a log curve past +50% a week (a 45x week scores the full 30).
 * Velocity is TVL per day of life on a log curve from $200K a day (a year or
 * more of history, or an unknown listing date, scores little or a flat 5).
 * Solo is one chain (15) or two (7). Bleed is TVL leaving past -20% a week.
 * Unproven is no listing date (10) or a listing too recent to have a record.
 */
export function rugRisk(protocol: SnapshotProtocol, asOf: string): RugRisk {
  const growth = finite(protocol.change_7d, 0);
  const age = ageDays(asOf, protocol.listed_at);
  const signals: RiskSignal[] = [];

  const flash = growth > 50 ? 30 * Math.min(1, Math.max(0, Math.log(growth / 50) / Math.log(20))) : 0;
  signals.push({
    id: 'flash',
    label: 'Flash growth',
    points: round1(flash),
    max: 30,
    detail: growth > 50 ? `TVL up ${round1(growth)}% in 7 days` : 'No seven-day spike',
  });

  let velocity: number;
  let velocityDetail: string;
  if (age === null) {
    velocity = 5;
    velocityDetail = 'No listing date, so the arrival rate cannot be checked';
  } else if (age >= 365) {
    velocity = 0;
    velocityDetail = `${age} days of history: the money did not arrive overnight`;
  } else {
    const perDay = protocol.tvl_usd / Math.max(age, 1);
    velocity = 25 * Math.min(1, Math.max(0, Math.log10(perDay / 200_000) / Math.log10(50)));
    velocityDetail = `${money(perDay)} of TVL per day of life`;
  }
  signals.push({ id: 'velocity', label: 'Fast money', points: round1(velocity), max: 25, detail: velocityDetail });

  const solo = protocol.chains.length === 1 ? 15 : protocol.chains.length === 2 ? 7 : 0;
  signals.push({
    id: 'solo',
    label: 'Single chain',
    points: solo,
    max: 15,
    detail: protocol.chains.length <= 1 ? 'All of its TVL sits on one chain' : `TVL spread over ${protocol.chains.length} chains`,
  });

  const bleed = growth < -70 ? 15 : growth < -20 ? 15 * (-20 - growth) / 50 : 0;
  signals.push({
    id: 'bleed',
    label: 'Capital leaving',
    points: round1(bleed),
    max: 15,
    detail: growth < -20 ? `TVL down ${round1(-growth)}% in 7 days` : 'No seven-day outflow',
  });

  let unproven: number;
  let unprovenDetail: string;
  if (age === null) {
    unproven = 10;
    unprovenDetail = 'No listing date: there is no record to check';
  } else if (age < 30) {
    unproven = 12;
    unprovenDetail = `Listed ${age} days ago: almost no record`;
  } else if (age < 90) {
    unproven = 8;
    unprovenDetail = `Listed ${age} days ago: a short record`;
  } else if (age < 180) {
    unproven = 4;
    unprovenDetail = `Listed ${age} days ago`;
  } else {
    unproven = 0;
    unprovenDetail = `Listed ${age} days ago`;
  }
  signals.push({ id: 'unproven', label: 'No track record', points: unproven, max: 15, detail: unprovenDetail });

  const score = round1(signals.reduce((n, s) => n + s.points, 0));
  return { score, band: bandOf(score), signals };
}

/** The risk-adjusted implied value: the raw value discounted by the rug score. */
export function adjustedValue(raw: number, risk: RugRisk, model: ModelConstants): number {
  return Math.max(1, Math.round(raw * (1 - model.risk_discount * (risk.score / 100))));
}

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
/** Categories that are a wrapped, staked or bridged product of another protocol, not a launch. */
const WRAPPED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
/** A name carrying one of these whole words is a wrapped or staked product of a token that trades. */
const WRAPPED_WORDS = /\b(wrapped|staked|staking)\b/i;
/** A name beginning with an exchange's name is that exchange's product, not a launch of its own. */
const EXCHANGE_PREFIX = /^(binance|coinbase|bybit|kraken|bitget|okx|bitfinex|gemini)\b/i;

/** Why a pre-token protocol is set aside from the ranking, or null when it is a launch. */
export function setAsideReason(p: SnapshotProtocol): string | null {
  if (p.category !== null && WRAPPED_CATEGORIES.has(p.category)) return `Category ${p.category}: a wrapped, staked or bridged product, not a launch`;
  if (WRAPPED_WORDS.test(p.name)) return 'A wrapped or staked product of a token that already trades';
  if (EXCHANGE_PREFIX.test(p.name)) return 'An exchange product, not a protocol launch of its own';
  if (VERSIONED.test(p.name)) return 'A versioned pool of another protocol';
  return null;
}

/** Whether a protocol is one the board may rank: pre-token and a launch, not a wrapped product. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && setAsideReason(p) === null;
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const index = bySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug, even one the snapshot no longer carries (it cannot, but the
  // board's coverage is the gate's row and is never gambled on a missing record).
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: rankable pre-token protocols below the watchlist floor, every one of them.
  // Never a replacement for a watchlist row: a chosen protocol stays chosen.
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => {
    const { implied, growthPct, growthMult, maturityMult, age } = impliedValue(p, snapshot.as_of, model);
    const risk = rugRisk(p, snapshot.as_of);
    return { p, raw: implied, adjusted: adjustedValue(implied, risk, model), risk, growthPct, growthMult, maturityMult, age };
  });
  scored.sort((a, b) => b.adjusted - a.adjusted || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    age_days: s.age,
    implied_value_usd: s.adjusted,
    raw_implied_value_usd: s.raw,
    rug_risk: s.risk,
    model: {
      base_multiple: model.base_multiple,
      growth_pct: s.growthPct,
      growth_multiplier: round4(s.growthMult),
      maturity_multiplier: round4(s.maturityMult),
      risk_discount: model.risk_discount,
      age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age, s.risk).map(stepText),
  }));
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The rug check every plan starts with: the wording follows the row's risk band. */
function rugCheckStep(risk: RugRisk): FarmStep {
  if (risk.band === 'HIGH' || risk.band === 'SEVERE') {
    return {
      text: `This one is ${risk.band.toLowerCase()} risk at ${risk.score} out of 100: do not deposit until you have opened the protocol's own docs, confirmed the contracts the app uses are the ones it lists, and checked who can change them, and size the deposit as money you can lose outright.`,
      cost: 'nothing but the check',
      time: '30 minutes',
    };
  }
  if (risk.band === 'ELEVATED') {
    return {
      text: `This one is elevated risk at ${risk.score} out of 100: open the protocol's own docs, confirm the contracts the app uses are the ones it lists, and keep the deposit small enough that losing it outright would not hurt.`,
      cost: 'nothing but the check',
      time: '20 minutes',
    };
  }
  if (risk.band === 'GUARDED') {
    return {
      text: `This one is guarded at ${risk.score} out of 100: open the protocol's own docs, confirm the contracts the app uses are the ones it lists, and check who can change them before you deposit.`,
      cost: 'nothing but the check',
      time: '15 minutes',
    };
  }
  return {
    text: `Before you deposit, open the protocol's own docs page and confirm the contracts the app uses are the ones it lists.`,
    cost: 'nothing but the check',
    time: '10 minutes',
  };
}

/** The category's one action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedge.`;
  if (c.includes('prediction')) return `Fund $${capital} and place one market position on ${name}.`;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time. The plan is derived from
 * the protocol's own record (category, chains, TVL, age, rug band), never from a hand-written list
 * of names. The second step is always the rug check, worded for the row's band.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null, risk: RugRisk): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const action = actionFor(p, capital, chain);
  return [
    {
      text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    rugCheckStep(risk),
    {
      text: action,
      cost: `$${capital} of capital and about $${capital >= 150 ? 8 : 4} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: `Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.`,
      cost: 'about $2 of gas a week',
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes, then write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.`,
      cost: 'no fee to check, and never pay to claim',
      time: '15 minutes',
    },
  ];
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** The pre-token protocols set aside from the ranking, with the reason each is not a launch. */
export function setAsideRows(snapshot: Snapshot): SetAsideRow[] {
  return snapshot.protocols
    .filter((p) => isPreToken(p) && setAsideReason(p) !== null)
    .sort((a, b) => b.tvl_usd - a.tvl_usd)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      tvl_usd: p.tvl_usd,
      reason: setAsideReason(p)!,
    }));
}

/** A board row's compact form for data.js, with the farm plan generated in the page. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    raw_implied_value_usd: row.raw_implied_value_usd,
    rug_score: row.rug_risk.score,
    rug_band: row.rug_risk.band,
    rug_signals: row.rug_risk.signals.map((s) => ({ id: s.id, points: s.points })),
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const setAside = setAsideRows(snapshot);
  const riskCounts: Record<RugRisk['band'], number> = { LOW: 0, GUARDED: 0, ELEVATED: 0, HIGH: 0, SEVERE: 0 };
  for (const r of board) riskCounts[r.rug_risk.band]++;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    live_size: live.length,
    set_aside_size: setAside.length,
    risk_counts: riskCounts,
    rows: board.map(radarRow),
    live,
    set_aside: setAside,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
