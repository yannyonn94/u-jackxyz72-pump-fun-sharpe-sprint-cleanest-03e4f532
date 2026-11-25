# STRATEGY.md — Quiet-momentum rider, tuned for hourly Sharpe

## The bet

This competition ranks by **hourly Sharpe ratio** on a 6-hour forward window, not by
PnL — but a prize still needs net PnL above 0. Sharpe rewards steady hourly gains
with low variance, so the bot needs small, repeatable wins and no losing hours, not
one moonshot. The guardrails (≥ 20 coins with round trips ≥ 0.01 SOL, max drawdown
≤ 50%) are as binding as the rank key: an entry that misses them ranks below every
entry that meets them.

## What the dev dataset says (measured, not guessed)

The dev window holds 1,222 coins over 24 hours. The median coin peaks at 1.24x its
creation price, so buying coins at random loses; the price multiple is capped at
~14.7x (the completion price, a fixed function of the bonding curve). Of the coins
that reach 50 SOL of real reserves 62% complete — but they jump from below 50 to
85 SOL in a single trade, so by the time 50 SOL is observed the coin has already
completed or is about to dump. The decisive facts, found by grading earlier bots
on this template family:

- Buying a launch spike loses; buying every new coin early loses ~−6% per trade.
- Dips after the spike do not bounce.
- Momentum on mature coins (age ≥ 300 slots, +20% over a trailing 300-slot window,
  ≥ 3 SOL net flow, ≥ 5 buyers, near the window high, no spike in the last 60
  slots) survives — and the trade-count filter (≤ 20 trades in the window) is what
  makes it survive: burst-y coins dump in cliffs no 2-slot-latency stop can catch.
- Orders decided on slot s fill at slot s+2, so tight stops realize far worse than
  their trigger, and a second buy must never stack while the first is still
  pending, or adds buy the top of a spike on stale prices.

## What was tried (all graded on the dev window with grade-local --driver process)

Net PnL in SOL; Sharpe is hourly, the rank key.

| Variant | Net PnL | Sharpe | Max DD | Coins | Fills | Win rate | Top-3 share | PnL ex top-3 |
|---|---|---|---|---|---|---|---|---|
| A1 steady, devSold entry filter | −0.144 | −0.314 | 1.93% | 16 | 62 | 29.6% | 90% | −0.206 |
| A2 steady, no devSold filter | −0.204 | −0.446 | 2.29% | 60 | 178 | 14.5% | 86% | −0.266 |
| A3 steady + winner entry set | −0.085 | −0.165 | 1.29% | 57 | 137 | 11.1% | 98% | −0.207 |
| **B2 fat-tail (TP +35%, SL −4%)** | **+0.279** | **+0.199** | **1.17%** | **62** | **156** | **12.7%** | **76%** | **−0.105** |
| A5 steady (fixed code) | −0.019 | −0.032 | 0.71% | 62 | 155 | 13.9% | 79% | −0.183 |
| C medium (TP +12%, SL −8%) | +0.004 | +0.009 | 0.90% | 62 | 155 | 20.0% | 69% | −0.135 |
| B2a fat-tail long (TP +50%, trail 12%@20%, hold 1200) | +0.016 | +0.014 | 3.33% | 49 | 128 | 8.8% | 75% | −0.283 |
| B2b fat-tail, SL −3% | +0.279 | +0.199 | 1.28% | 49 | 128 | 12.3% | 75% | −0.105 |
| **B2b + probe pacer v2 (0.011 SOL, rq ≥ 1.2, 2 in flight, pace 5/h, cap 30) — SHIPPED** | **+0.293** | **+0.209** | **1.22%** | **52** | **134** | **13.3%** | **75%** | **−0.091** |

Stress (`grade-local --stress 10 --stress-jobs 3`, rebuilt copies of the dev
window) on the shipped variant: **median −0.18 SOL, p10 −0.25, p90 +0.06;
8 of 10 copies lost money; the dev score sits above 10 of 10 copies**, and
the kit warns the dev score is above 90% of the copies. At 2x fees the dev
PnL is still +0.161 SOL. Honest reading: the edge is a fat tail tied to this
window's own coins — on a reshuffled window the bot usually loses a little
and occasionally wins big. The 6-hour slices above show the same shape (2 of 4
positive, one +0.356). No candidate graded in this build (or in the two
earlier bots on this template family) showed a broad, stress-robust edge: the
market's base rate is negative and the winners are rare. The shipped variant
is the best ticket available — the highest dev Sharpe and PnL of everything
graded, with the guardrail met everywhere — not a claim that the edge is
broad.

Reading the table:

- The steady/medium exits cap winners too early and let losers run to the stop: they
  lose or break even. The fat-tail exits (TP +35%, SL −4%, trail 10% armed at +15%)
  are the only profile that clears fees — the winners pay for the many small losers.
- A longer hold and wider trail (B2a) give the gains back: +0.016. SL −3% vs −4%
  (B2b vs B2) is a wash — the stop rarely binds exactly at the trigger under
  2-slot latency.
- The devSold entry filter (A1) bought quality but only 16 coins — fatal for the
  20-coin bar. Dropping it (A2) bought quantity at terrible quality. The winner's
  entry set (cooldown 600, max 3 entries/coin, min 2 SOL real reserve, min 5 buys,
  adds only into strength with flow) fixed both.
- Three bugs found by the strategy's own stderr diagnostics and fixed mid-build:
  probe buys that never filled stuck the pacer forever (added a 20-slot timeout);
  sells stacked on pending sells (added a pending-sell guard); a 60-slot recency
  rule on the window's first price sample threw out 3,903 evaluations (removed);
  a stale exit sold quiet winners (removed); adds stacked while a buy was pending
  (added a pending-buy guard). Together they took the fat-tail variant from +0.004
  to +0.279 SOL.

## The final-window check (6-hour slices, real harness engine)

The dev window is 24 hours; the final is 6. The bot was run through the harness's
own replay engine on four 6-hour slices of the dev window (hours 0–6, 6–12, 12–18,
18–24), with the real fill model (latency, fees, slippage, seeded failed txs):

| Slice | Net PnL | Sharpe | Coins counted | Guardrail |
|---|---|---|---|---|
| 0–6h | +0.013 | +0.099 | 28 | met |
| 6–12h | −0.082 | −0.729 | 28 | met |
| 12–18h | +0.356 | +0.571 | 28 | met |
| 18–24h | −0.037 | −0.691 | 28 | met |

Every slice clears the 20-coin bar with 8 coins of margin, and max drawdown stays
under 1% — but the Sharpe spread (−0.73…+0.57) shows the final window is
high-variance for every entry: with only 6 hourly marks, one fat-tail winner
landing (or not) in the window decides the rank. The shipped bot maximizes the
number of lottery tickets (momentum entries plus up to 30 probe round trips) while
keeping the per-trade loss small, so the chance a winner lands in the window is
as high as this market allows.

## What shipped and why

B2b + probe pacer v2 ships: the best dev Sharpe (+0.209) and PnL (+0.293 SOL) of
every candidate, the lowest drawdown among the profitable variants (1.22% vs the
50% cap), the guardrail met on every 6-hour slice with margin, and deterministic
(two executions reproduced byte for byte).
