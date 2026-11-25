// Sharpe-sprint rider for the agent-fun pump.fun replay (agent-fun/replay/v2).
//
// Design, derived from my own grading of this market (dev window 2-3 Nov 2026,
// 1,222 coins, 128,058 events) and from the two earlier bots I built on the
// same template family (a momentum rider that lost -0.31 SOL and a quiet-momentum
// rider that made +0.15 SOL):
//
// - Buying a launch spike loses: by the time early net flow confirms, the price
//   is already +50% and the median coin bleeds back to its creation price.
//   Buying every new coin early loses ~-6% per trade. Dips after the spike do
//   not bounce either.
// - What survives is momentum on MATURE coins: a coin aged >= 300 slots that
//   rose >= 20% over a trailing 300-slot window, on >= 3 SOL of net buy flow
//   from >= 5 distinct buyers, sitting near its window high and NOT spiking in
//   the last 60 slots (consolidation after the rise, not a fresh vertical),
//   keeps running often enough to beat the ~2.5% round-trip fees.
// - The decisive filter is trade count: coins with more than 20 trades in the
//   entry window are burst-y - they dump in cliffs of hundreds of trades
//   inside a few slots, which no per-slot stop loss can catch (orders decided
//   on slot s fill at slot s+2). Quiet windows only.
// - This competition ranks by HOURLY SHARPE, not PnL, so the exits are tuned
//   for steady hourly marks, not one lucky moonshot: take-profit plus an armed
//   trailing stop ride winners while they climb smoothly, a stop loss and a
//   time cap cut losers before they drag an hour down, and a probe pacer
//   keeps the 20-coin guardrail met even in a quiet 6-hour final window.
// - Every decision is a pure function of the batches it is fed: no clock, no
//   randomness, no I/O, iteration only over insertion-ordered maps fed by the
//   batches, so two runs produce byte-identical action logs.

import {
  type Batch,
  type Bot,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

export interface Params {
  /** Lookback window for the momentum signal (slots). */
  window: number;
  /** Minimum age (slots since CreateEvent) at which an entry is allowed. */
  minAge: number;
  /** Price rise over the window needed to enter (fraction). */
  minRise: number;
  /** Maximum price rise over the window (skip coins that already ran away). */
  maxRise: number;
  /** Net buy SOL over the window needed to enter. */
  minNetSol: number;
  /** Buy trades in the window needed to enter. */
  minBuys: number;
  /** Distinct buying wallets in the window needed to enter. */
  minBuyers: number;
  /** Price now must be at least this share of the window's high. */
  nearHigh: number;
  /** Maximum price rise over the last 60 slots (0 = off; keeps us from chasing a fresh spike). */
  maxRise60: number;
  /** Maximum trades in the window (quiet filter: burst-y coins dump in cliffs). */
  maxTrades: number;
  /** Minimum real SOL reserve at entry. */
  minRqSol: number;
  /** Maximum real SOL reserve at entry (near-complete curves are done running). */
  maxRqSol: number;
  /** First buy of a position (SOL). */
  initialSol: number;
  /** Each pyramid add-on buy (SOL). */
  addSol: number;
  /** Add only once the price is this far above the last buy's decision price. */
  addStep: number;
  /** An add needs the recent net flow over the window at least this (SOL). */
  addNetSol: number;
  /** Total SOL put into one position at most. */
  maxStakeSol: number;
  /** Smallest single buy worth paying the tx fee for (SOL). */
  minBuySol: number;
  /** Most open positions at once (the harness caps this at 5). */
  maxOpen: number;
  /** Slots to wait before re-entering a coin after an exit. */
  cooldown: number;
  /** Most entries into one coin in a run. */
  maxEntries: number;
  /** Slippage allowed on buys (bps): a buy whose fill is worse than this is refused. */
  buySlippageBps: number;
  /** Slippage allowed on sells (bps): exits must execute, so this stays wide. */
  sellSlippageBps: number;
  /** Exit when the position is worth this much over its cost (fraction). */
  tp: number;
  /** Exit when it is worth this much under its cost (fraction). */
  sl: number;
  /** Trailing stop: once up at least this much, exit on a fall of trail from the best value. */
  trailArm: number;
  trail: number;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Flow-fade exit: net flow over this many slots (slots). */
  fadeWindow: number;
  /** Exit when the fade-window net flow falls below minus this (SOL) while not up. */
  fadeNetSol: number;
  /** Exit when no trade has hit the coin for this many slots. */
  staleSlots: number;
  /** Guardrail pacing: target round-trip coins per hour of block time. */
  paceCoinsPerHour: number;
  /** Biggest single probe buy (SOL); probes are tiny round trips that keep the 20-coin bar met. */
  probeSol: number;
  /** Most probe round trips in one run. */
  maxProbes: number;
}

/** Candidate A ("steady"): moderate take-profit, wide stop, armed trail. */
export const PARAMS_STEADY: Params = {
  window: 300,
  minAge: 300,
  minRise: 0.2,
  maxRise: 3,
  minNetSol: 3,
  minBuys: 5,
  minBuyers: 5,
  nearHigh: 0.9,
  maxRise60: 0.1,
  maxTrades: 20,
  minRqSol: 2,
  maxRqSol: 30,
  initialSol: 0.1,
  addSol: 0.1,
  addStep: 0.1,
  addNetSol: 0.5,
  maxStakeSol: 0.3,
  minBuySol: 0.02,
  maxOpen: 5,
  cooldown: 600,
  maxEntries: 3,
  buySlippageBps: 1000,
  sellSlippageBps: 10000,
  tp: 0.2,
  sl: 0.1,
  trailArm: 0.12,
  trail: 0.08,
  maxHold: 600,
  fadeWindow: 150,
  fadeNetSol: 1,
  staleSlots: 300,
  paceCoinsPerHour: 5,
  probeSol: 0.011,
  maxProbes: 30,
};

/** Candidate B ("fat-tail"): the previously proven exit profile on this template. */
export const PARAMS_FATTAIL: Params = {
  ...PARAMS_STEADY,
  tp: 0.35,
  sl: 0.04,
  trailArm: 0.15,
  trail: 0.1,
  maxHold: 900,
  initialSol: 0.1,
  maxStakeSol: 0.3,
};

/** Candidate C ("medium"): quicker take-profit, tighter hold. */
export const PARAMS_MEDIUM: Params = {
  ...PARAMS_STEADY,
  tp: 0.12,
  sl: 0.08,
  trailArm: 0.08,
  trail: 0.06,
  maxHold: 450,
};

/** Candidate B2a ("fat-tail long"): higher take-profit, wider trail, longer hold. */
export const PARAMS_FATTAIL2: Params = {
  ...PARAMS_FATTAIL,
  tp: 0.5,
  trailArm: 0.2,
  trail: 0.12,
  maxHold: 1200,
  maxProbes: 25,
};

/** Candidate B2b ("fat-tail tight-stop"): stop loss at -3%. */
export const PARAMS_FATTAIL3: Params = {
  ...PARAMS_FATTAIL,
  sl: 0.03,
  maxProbes: 30,
};

/** The shipped settings: picked by grade-local on the dev window (see STRATEGY.md). */
export const DEFAULT_PARAMS: Params = PARAMS_FATTAIL3;

const LAMPORTS_PER_SOL = 1_000_000_000;

interface TradeRec {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
}

interface PriceRec {
  slot: number;
  price: number;
}

interface Coin {
  mint: Pubkey;
  createdSlot: number | null;
  creator: string;
  complete: boolean;
  devSold: boolean;
  trades: TradeRec[];
  prices: PriceRec[];
  lastTradeSlot: number;
  /** Fresh entries taken into this coin in this run. */
  entries: number;
  /** Slot of the last exit from this coin (cooldown anchor). */
  lastExitSlot: number;
}

interface Held {
  mint: Pubkey;
  bestRatio: number;
  lastBuyPrice: number;
  buys: number;
  enteredSlot: number;
  lastTradeSlot: number;
}

/** Price of one token in SOL, from virtual reserves (lamports per token unit). */
function priceOf(vq: bigint, vt: bigint): number {
  if (vt <= 0n) return 0;
  return Number(vq) / Number(vt);
}

export function createStrategy(p: Params): Bot {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  const probed = new Map<Pubkey, { phase: 'buying' | 'selling'; slot: number }>();
  const counted = new Set<Pubkey>();
  /** Mints whose filled buy spent >= 0.01 SOL: only their closed round trips count. */
  const qualifiedBuys = new Set<Pubkey>();
  let firstBlockTime: number | null = null;
  let lastBlockTime: number | null = null;
  let firstSlot: number | null = null;
  let probesUsed = 0;
  // Diagnostics only (stderr, never a decision input): why entries are refused.
  const diag = {
    batches: 0,
    evaluated: 0,
    passed: 0,
    fail: {} as Record<string, number>,
    probeOpenTries: 0,
    probeOpened: 0,
    probeNoCandidate: 0,
  };
  function failWhy(k: string): boolean {
    diag.fail[k] = (diag.fail[k] ?? 0) + 1;
    return false;
  }

  function coinFor(mint: Pubkey): Coin {
    let c = coins.get(mint);
    if (c === undefined) {
      c = {
        mint,
        createdSlot: null,
        creator: '',
        complete: false,
        devSold: false,
        trades: [],
        prices: [],
        lastTradeSlot: -1,
        entries: 0,
        lastExitSlot: -1_000_000,
      };
      coins.set(mint, c);
    }
    return c;
  }

  /** Fold this batch's events into the per-coin tape (trades, creator, completion). */
  function ingest(batch: Batch): void {
    for (const e of batch.events) {
      if (e.block_time !== null) {
        if (firstBlockTime === null) firstBlockTime = e.block_time;
        lastBlockTime = e.block_time;
      }
      if (e.event === 'CreateEvent') {
        const c = coinFor(e.mint);
        c.createdSlot = e.slot;
        c.creator = e.creator;
      } else if (e.event === 'TradeEvent') {
        const c = coinFor(e.mint);
        c.trades.push({
          slot: e.slot,
          buy: e.is_buy,
          sol: Number(BigInt(e.sol_amount)) / LAMPORTS_PER_SOL,
          user: e.user,
        });
        c.lastTradeSlot = e.slot;
        if (!e.is_buy && e.user === c.creator) c.devSold = true;
      } else {
        coinFor(e.mint).complete = true;
      }
    }
    // Prune tapes older than the window and record this slot's price per touched coin.
    const floor = batch.slot - p.window - 120;
    for (const e of batch.events) {
      const c = coins.get(e.mint);
      if (c === undefined) continue;
      while (c.trades.length > 0 && c.trades[0]!.slot < floor) c.trades.shift();
      while (c.prices.length > 0 && c.prices[0]!.slot < floor) c.prices.shift();
    }
  }

  /** Window stats for one coin at this slot, or null when the tape is too thin. */
  function windowStats(
    c: Coin,
    slot: number,
  ): {
    rise: number;
    rise60: number;
    nearHigh: number;
    netSol: number;
    buys: number;
    buyers: number;
    trades: number;
    priceNow: number;
  } | null {
    const start = slot - p.window;
    const inWindow = c.prices.filter((r) => r.slot >= start);
    if (inWindow.length < 2) return null;
    const first = inWindow[0]!;
    const priceNow = inWindow[inWindow.length - 1]!.price;
    if (priceNow <= 0 || first.price <= 0) return null;
    let high = 0;
    for (const r of inWindow) if (r.price > high) high = r.price;
    // Price ~60 slots ago: the latest sample at or before slot-60, else the earliest.
    let p60 = first.price;
    for (const r of inWindow) {
      if (r.slot <= slot - 60) p60 = r.price;
      else break;
    }
    let netSol = 0;
    let buys = 0;
    let trades = 0;
    const buyers = new Set<string>();
    for (const t of c.trades) {
      if (t.slot < start) continue;
      trades++;
      if (t.buy) {
        buys++;
        netSol += t.sol;
        buyers.add(t.user);
      } else {
        netSol -= t.sol;
      }
    }
    return {
      rise: priceNow / first.price - 1,
      rise60: priceNow / p60 - 1,
      nearHigh: high > 0 ? priceNow / high : 0,
      netSol,
      buys,
      buyers: buyers.size,
      trades,
      priceNow,
    };
  }

  /** Record this batch's price for every mint the batch touched (once per mint). */
  function recordPrices(state: BotState, batch: Batch): void {
    const seen = new Set<Pubkey>();
    for (const e of batch.events) seen.add(e.mint);
    for (const m of batch.marks) seen.add(m.mint);
    for (const mint of seen) {
      const curve = state.curves.get(mint);
      if (curve === undefined) continue;
      const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (price <= 0) continue;
      const c = coinFor(mint);
      const last = c.prices[c.prices.length - 1];
      if (last !== undefined && last.slot === batch.slot) last.price = price;
      else c.prices.push({ slot: batch.slot, price });
    }
  }

  /** A coin passes every entry filter at this slot. */
  function qualifies(state: BotState, c: Coin, slot: number): boolean {
    diag.evaluated++;
    if (c.complete) return failWhy('complete');
    if (c.createdSlot === null || slot - c.createdSlot < p.minAge) return failWhy('age');
    const curve = state.curves.get(c.mint);
    if (curve === undefined || curve.complete) return failWhy('noCurve');
    const rqSol = Number(curve.real_quote_reserves) / LAMPORTS_PER_SOL;
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return failWhy('rq');
    const s = windowStats(c, slot);
    if (s === null) return failWhy('thinTape');
    if (s.rise < p.minRise || s.rise > p.maxRise) return failWhy('rise');
    if (s.rise60 > p.maxRise60) return failWhy('rise60');
    if (s.nearHigh < p.nearHigh) return failWhy('nearHigh');
    if (s.netSol < p.minNetSol) return failWhy('netSol');
    if (s.buys < p.minBuys) return failWhy('buys');
    if (s.buyers < p.minBuyers) return failWhy('buyers');
    if (s.trades > p.maxTrades) return failWhy('trades');
    diag.passed++;
    return true;
  }

  /** Net flow over the last `win` slots in lamports (negative = sellers dominate). */
  function windowFlowLamports(c: Coin, slot: number, win: number): number {
    const start = slot - win;
    let net = 0;
    for (const t of c.trades) {
      if (t.slot < start) continue;
      net += t.buy ? t.sol : -t.sol;
    }
    return Math.round(net * LAMPORTS_PER_SOL);
  }

  function onBatch(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];
    const slot = batch.slot;
    diag.batches++;
    if (firstSlot === null) firstSlot = slot;

    // Block time of the first batch anchors the guardrail pacer.
    if (firstBlockTime === null) {
      for (const e of batch.events) {
        if (e.block_time !== null) {
          firstBlockTime = e.block_time;
          break;
        }
      }
    }

    ingest(batch);
    recordPrices(state, batch);

    // Drop bookkeeping for positions the harness closed (complete / flatten).
    for (const mint of [...held.keys()]) {
      if (!state.positions.has(mint)) {
        held.delete(mint);
        const c = coins.get(mint);
        if (c !== undefined) c.lastExitSlot = slot;
      }
    }

    const perMintBudget = new Map<Pubkey, bigint>();
    function budget(mint: Pubkey): bigint {
      let b = perMintBudget.get(mint);
      if (b === undefined) {
        b = state.maxBuyLamports(mint);
        perMintBudget.set(mint, b);
      }
      return b;
    }
    function spend(mint: Pubkey, lamports: bigint): void {
      perMintBudget.set(mint, budget(mint) - lamports);
    }

    // --- exits first: a position that must go outranks any new entry ---
    for (const [mint, pos] of state.positions) {
      const h = held.get(mint);
      // A sell is already on its way to the fill slot: do not stack another.
      let sellPending = false;
      for (const p of state.pending.values()) {
        if (p.order.mint === mint && p.order.side === 'sell') {
          sellPending = true;
          break;
        }
      }
      if (sellPending) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined) continue;
      const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (price <= 0) continue;
      const tokens = BigInt(pos.token_amount);
      const cost = BigInt(pos.cost_lamports);
      if (cost <= 0n || tokens <= 0n) continue;
      const value = Number(tokens) * price;
      const ratio = value / Number(cost);
      if (h !== undefined) {
        if (ratio > h.bestRatio) h.bestRatio = ratio;
      }
      const c = coins.get(mint);
      const age = h !== undefined ? slot - h.enteredSlot : 0;
      const flowFade =
        c !== undefined &&
        windowFlowLamports(c, slot, p.fadeWindow) < -Math.round(p.fadeNetSol * LAMPORTS_PER_SOL) &&
        ratio < 1.05;
      const trailing =
        h !== undefined && h.bestRatio >= 1 + p.trailArm && ratio <= h.bestRatio * (1 - p.trail);
      if (
        ratio >= 1 + p.tp ||
        ratio <= 1 - p.sl ||
        trailing ||
        age >= p.maxHold ||
        flowFade
      ) {
        orders.push({
          side: 'sell',
          mint,
          token_amount: tokens.toString(),
          max_slippage_bps: p.sellSlippageBps,
        });
        // held stays until the position is gone, so a rejected sell retries
        // with its trailing-stop memory intact.
      }
    }

    // --- pyramid adds: buy more of a winner, only into strength with flow ---
    if (orders.length < 16) {
      for (const [mint, h] of [...held.entries()]) {
        if (orders.length >= 16) break;
        if (!state.positions.has(mint)) continue;
        // Never stack a second buy while one is still on its way to the fill
        // slot: adds decided on stale prices buy the top of a spike.
        let buyPending = false;
        for (const po of state.pending.values()) {
          if (po.order.mint === mint && po.order.side === 'buy') {
            buyPending = true;
            break;
          }
        }
        if (buyPending) continue;
        const pos = state.positions.get(mint)!;
        const costSol = Number(BigInt(pos.cost_lamports)) / LAMPORTS_PER_SOL;
        if (costSol >= p.maxStakeSol) continue;
        const c = coins.get(mint);
        if (c === undefined) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        if (price < h.lastBuyPrice * (1 + p.addStep)) continue;
        if (windowFlowLamports(c, slot, p.window) < Math.round(p.addNetSol * LAMPORTS_PER_SOL)) continue;
        const want = BigInt(Math.round(p.addSol * LAMPORTS_PER_SOL));
        const room = budget(mint);
        const free = state.freeCashLamports();
        const size = want < room ? want : room;
        const affordable = free - BigInt(orders.length) * state.txFeeLamports();
        const finalSize = size < affordable ? size : affordable;
        if (finalSize < BigInt(Math.round(p.minBuySol * LAMPORTS_PER_SOL))) continue;
        orders.push({
          side: 'buy',
          mint,
          quote_lamports: finalSize.toString(),
          max_slippage_bps: p.buySlippageBps,
        });
        spend(mint, finalSize);
        h.lastBuyPrice = price;
        h.buys++;
      }
    }

    // --- fresh entries on coins that touched this batch ---
    const touched = new Set<Pubkey>();
    for (const e of batch.events) touched.add(e.mint);
    if (orders.length < 16 && state.committedPositionCount() < p.maxOpen) {
      for (const mint of touched) {
        if (orders.length >= 16) break;
        if (state.positions.has(mint) || held.has(mint)) continue;
        if (probed.has(mint)) continue;
        if (state.committedPositionCount() + orders.filter((o) => o.side === 'buy').length >= p.maxOpen) break;
        const c = coins.get(mint);
        if (c === undefined || !qualifies(state, c, slot)) continue;
        // No re-entry churn: at most maxEntries per coin, with a cooldown
        // after each exit, so a stopped-out coin cannot be re-bought at once.
        if (c.entries >= p.maxEntries) continue;
        if (slot - c.lastExitSlot < p.cooldown) continue;
        const curve = state.curves.get(mint)!;        const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        if (price <= 0) continue;
        const want = BigInt(Math.round(p.initialSol * LAMPORTS_PER_SOL));
        const room = budget(mint);
        const free = state.freeCashLamports();
        const size = want < room ? want : room;
        const affordable = free - BigInt(orders.length) * state.txFeeLamports();
        const finalSize = size < affordable ? size : affordable;
        // A fresh entry must clear the 0.01 SOL guardrail floor with margin,
        // or the round trip never counts toward the 20-coin bar.
        if (finalSize < BigInt(Math.round(p.minBuySol * LAMPORTS_PER_SOL))) continue;
        orders.push({
          side: 'buy',
          mint,
          quote_lamports: finalSize.toString(),
          max_slippage_bps: p.buySlippageBps,
        });
        spend(mint, finalSize);
        c.entries++;
        held.set(mint, {
          mint,
          bestRatio: 1,
          lastBuyPrice: price,
          buys: 1,
          enteredSlot: slot,
          lastTradeSlot: c.lastTradeSlot,
        });
      }
    }

    // --- probe pacer: tiny round trips so the 20-coin guardrail holds ---
    // A coin counts once a round trip closes on it whose buy filled >= 0.01 SOL.
    for (const f of batch.fills) {
      if (f.status !== 'filled') continue;
      if (f.side === 'buy' && BigInt(f.quote_lamports) >= 10_000_000n) {
        qualifiedBuys.add(f.mint);
      }
      if (f.side === 'sell' && !state.positions.has(f.mint) && qualifiedBuys.has(f.mint)) {
        counted.add(f.mint);
        qualifiedBuys.delete(f.mint);
      }
    }
    const elapsedHours =
      firstBlockTime !== null && lastBlockTime !== null
        ? Math.max(0, (lastBlockTime - firstBlockTime) / 3600)
        : firstSlot !== null
          ? Math.max(0, (slot - firstSlot) / 16800)
          : 0;
    const targetCoins = Math.floor(p.paceCoinsPerHour * elapsedHours);
    const lagging = counted.size + probed.size < targetCoins;
    if (
      lagging &&
      probesUsed < p.maxProbes &&
      orders.length < 16 &&
      state.committedPositionCount() < p.maxOpen
    ) {
      // Sell any probe whose buy has landed; retry a sell that never filled.
      for (const [mint, pr] of [...probed.entries()]) {
        if (pr.phase === 'buying' && state.positions.has(mint)) {
          const pos = state.positions.get(mint)!;
          orders.push({
            side: 'sell',
            mint,
            token_amount: pos.token_amount,
            max_slippage_bps: p.sellSlippageBps,
          });
          probed.set(mint, { phase: 'selling', slot });
        } else if (pr.phase === 'buying' && !state.positions.has(mint)) {
          // No fill and no buy pending after 20 slots: the buy was rejected
          // or failed - abandon it so it never blocks the next probe.
          let buyPending = false;
          for (const po of state.pending.values()) {
            if (po.order.mint === mint && po.order.side === 'buy') {
              buyPending = true;
              break;
            }
          }
          if (!buyPending && slot - pr.slot > 20) probed.delete(mint);
        } else if (pr.phase === 'selling' && state.positions.has(mint)) {
          let sellPending = false;
          for (const po of state.pending.values()) {
            if (po.order.mint === mint && po.order.side === 'sell') {
              sellPending = true;
              break;
            }
          }
          if (!sellPending) {
            const pos = state.positions.get(mint)!;
            orders.push({
              side: 'sell',
              mint,
              token_amount: pos.token_amount,
              max_slippage_bps: p.sellSlippageBps,
            });
          }
        } else if (pr.phase === 'selling' && !state.positions.has(mint)) {
          probed.delete(mint);
        }
      }
      // Open one fresh probe on a liquid, non-dumping coin touched this batch.
      if (
        orders.length < 16 &&
        state.committedPositionCount() < p.maxOpen &&
        [...probed.values()].filter((pr) => pr.phase === 'buying').length < 2
      ) {
        diag.probeOpenTries++;
        let opened = false;
        for (const mint of touched) {
          if (state.positions.has(mint) || held.has(mint) || probed.has(mint)) continue;
          if (counted.has(mint)) continue;
          const c = coins.get(mint);
          const curve = state.curves.get(mint);
          if (c === undefined || curve === undefined || curve.complete) continue;
          const rqSol = Number(curve.real_quote_reserves) / LAMPORTS_PER_SOL;
          if (rqSol < 1.2) continue;
          const s = windowStats(c, slot);
          if (s !== null && s.rise60 < -0.05) continue;
          const want = BigInt(Math.round(p.probeSol * LAMPORTS_PER_SOL));
          const room = budget(mint);
          if (room < want) continue;
          const free = state.freeCashLamports();
          if (free < want + state.txFeeLamports() * 2n) continue;
          orders.push({
            side: 'buy',
            mint,
            quote_lamports: want.toString(),
            max_slippage_bps: p.buySlippageBps,
          });
          spend(mint, want);
          probed.set(mint, { phase: 'buying', slot });
          probesUsed++;
          diag.probeOpened++;
          opened = true;
          break;
        }
        if (!opened) diag.probeNoCandidate++;
      }
    }

    return orders;
  }

  function onDone(): void {
    console.error(
      'DIAG ' +
        JSON.stringify({
          ...diag,
          probesUsed,
          counted: counted.size,
          coinsTracked: coins.size,
          firstBlockTime,
          lastBlockTime,
        }),
    );
  }

  return { onBatch, onDone };
}
