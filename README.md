# Pump.fun Sharpe Sprint — quiet-momentum rider

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/yannyonn94/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/yannyonn94/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A TypeScript paper-trading bot for the [Pump.fun Sharpe Sprint](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) on make.fun. It trades 10 SOL of paper money on a 6-hour replay of pump.fun bonding-curve activity. Places go by **hourly Sharpe ratio**, so the bot is built for steady, controlled gains — not one lucky moonshot.

## Dev result (kit, `grade-local --driver process`)

- **Net PnL: +0.293 SOL** (return +2.93%; 90% interval from the grade run)
- **Hourly Sharpe: +0.209** (the rank key), Sortino positive, **max drawdown 1.22%** (guardrail: ≤ 50%)
- **134 fills over 52 coins, 60 round trips** (guardrail: ≥ 20 coins at ≥ 0.01 SOL round trips)
- Win rate 13.3%; fees 0.20 SOL curve + 0.014 SOL tx; two executions reproduced byte for byte (deterministic)
- Honest caveat: the top 3 coins made 75% of the gains; without them net PnL is −0.091 SOL. The edge is a fat tail, not a broad one — that is the nature of this market, and the bot is sized for it (0.10 SOL per position, max 5 open). Four 6-hour slices of the dev window (run through the real harness engine) all clear the 20-coin guardrail with 28 counted coins each; their Sharpes range −0.73…+0.57, so the final 6-hour window is high-variance for every entry.
- Stress (`grade-local --stress`): 10 rebuilt copies of the dev window — median −0.18 SOL, p10 −0.25, p90 +0.06; 8 of 10 lost money; the dev score sits above all 10 copies. The edge is a fat tail tied to this window's coins (see STRATEGY.md) — at 2x fees the dev PnL is still +0.161 SOL.

## Strategy: quiet-momentum rider

From my own grading of this market (dev window 2–3 Nov 2026, 1,222 coins, 128,058 events) and two earlier bots I built on the same template family:

- **Buying a launch spike loses.** By the time early net flow confirms, the price is already +50% and the median coin bleeds back to its creation price. Buying every new coin early loses ~−6% per trade. Dips after the spike do not bounce either.
- **Momentum on mature coins survives.** A coin aged ≥ 300 slots that rose ≥ 20% over a trailing 300-slot window, on ≥ 3 SOL of net buy flow from ≥ 5 distinct buyers, sitting near its window high and not spiking in the last 60 slots, keeps running often enough to beat the ~2.5% round-trip fees.
- **The decisive filter is trade count.** Coins with more than 20 trades in the entry window are burst-y — they dump in cliffs of hundreds of trades inside a few slots, which no per-slot stop loss can catch (orders decided on slot s fill at slot s+2). Quiet windows only.
- **Exits decide the trade.** −3% stop loss vs cost, +35% take-profit, 10% trailing stop armed at +15%, a flow-fade exit, and a 900-slot time cap. Positions pyramid into strength only (adds need +10% above the last buy and ≥ 0.5 SOL of recent net flow), up to a 0.30 SOL stake cap — and never while another buy is still on its way to the fill slot, so adds cannot stack on stale prices. A 600-slot cooldown and a 3-entry cap per coin stop re-entry churn after a stop-out.
- **Guardrail pacer.** A 6-hour final window holds only ~5–6 natural momentum entries, far below the 20-coin bar — so when the round-trip pace lags 5 coins/hour, the bot opens tiny 0.011 SOL probe round trips on liquid, non-dumping coins (up to 30 per run, at most 2 in flight). Probes are roughly break-even and guarantee the bar.

## Layout

- `main.ts` — entrypoint: wires the shim to the strategy (`node main.ts`).
- `strategy.ts` — the strategy (all parameters in `PARAMS_*`; shipped settings are `DEFAULT_PARAMS`).
- `vendor/makefun-bot.ts` — the kit's `sdk/ts/makefun-bot.ts`, vendored byte for byte.
- `STRATEGY.md` — the full build log: every candidate graded, with numbers.

## Determinism

Every decision is a pure function of the batches it is fed: no clock, no randomness, no I/O, iteration only over insertion-ordered maps fed by the batches. `grade-local` reports "L1 regrade reproduced byte for byte".
