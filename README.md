# Rug Radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/OWNER/REPO/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/OWNER/REPO/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar for make.fun's `token-radar-01` bounty: pre-token protocols ranked by what their launch would be worth, discounted by how much each one looks like a rug.

## The model

Implied value follows only from the snapshot's own figures — a protocol's TVL, its seven-day growth, and how long it has run with no token:

```
implied = round( tvl_usd x 0.25 x growth x maturity )
growth   = 1 + clamp(change_7d, -60, 120) / 100 x 0.5
maturity = 0.6 + min(age_days, 1095) / 1095 x 0.4   (age unknown: 365)
```

Rug risk is five signals off the same snapshot, 0–100, in bands LOW 0–19, GUARDED 20–39, ELEVATED 40–59, HIGH 60–79, SEVERE 80–100:

| Signal | Points | What it measures |
| --- | --- | --- |
| Flash growth | 0–30 | Seven-day TVL spike, log curve past +50% (a 45x week scores 30) |
| Fast money | 0–25 | TVL per day of life, log curve from $200K/day (a year of history scores 0) |
| Single chain | 0–15 | One chain only: one exit for the money (two chains: 7) |
| Capital leaving | 0–15 | TVL falling past −20% in seven days |
| No track record | 0–15 | No listing date, or listed too recently to have a record |

The board ranks the risk-adjusted value:

```
adjusted = implied x (1 - 0.6 x risk / 100)
```

The worst score costs 60% of the value. No protocol name is special-cased: one function scores every row.

A wrapped, staked or bridged product of a token that already trades is not a launch — WBTC is Bitcoin on Ethereum, a staked-ETH product is ETH in a staking wrapper — so those protocols are set aside with their reason, never ranked. Live-token protocols are shown apart at their market caps.

The board covers all 40 watchlist protocols plus every rankable pre-token protocol below the watchlist floor (178 rows), and sets the 24 largest live-token protocols aside. Each row carries a six-step farm plan with costs and times; the second step is always the rug check, worded for the row's risk band.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../token-radar-01-kit/input/snapshot.json
```

`main.ts` reads the sealed snapshot, writes the ranked board to `out/board.json`, the dashboard's data to `out/data.js`, copies `dashboard/` and `screenshots/` to `out/`, and writes `out/dossier.json` with the vendored make.fun library. Open `out/dashboard/index.html` in a browser (it runs with no network) or serve `out/` and open the page from there.

## The dashboard

A static page, no framework and no network. Sortable and filterable board (search, risk band, category), a detail view for each protocol with the value math, the five-signal rug breakdown and the farm plan, plus Live token and Set aside views. The page recomputes every row's implied value and rug risk from the raw snapshot fields, so what it shows is what the model says.

---

<sub>Entered on [make.fun](https://make.fun/?ref=MAKEFUN&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
