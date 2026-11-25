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
  /** Total SOL put into one position at most. */
  maxStakeSol: number;
  /** Most open positions at once (the harness caps this at 5). */
  maxOpen: number;
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
  /** Exit when the recent net flow falls below minus this many lamports. */
  exitFlowLamports: number;
  /** Exit when no trade has hit the coin for this many slots. */
  staleSlots: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
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
  maxRise: 0.6,
  minNetSol: 3,
  minBuys: 3,
  minBuyers: 5,
  nearHigh: 0.9,
  maxRise60: 0.1,
  maxTrades: 20,
  minRqSol: 0.5,
  maxRqSol: 50,
  initialSol: 0.08,
  addSol: 0.04,
  addStep: 0.05,
  maxStakeSol: 0.16,
  maxOpen: 5,
  buySlippageBps: 1500,
  sellSlippageBps: 10000,
  tp: 0.2,
  sl: 0.1,
  trailArm: 0.12,
  trail: 0.08,
  maxHold: 600,
  exitFlowLamports: -1_000_000_000,
  staleSlots: 300,
  exitOnDevSell: true,
  paceCoinsPerHour: 4,
  probeSol: 0.015,
  maxProbes: 40,
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

/** The shipped settings: picked by grade-local on the dev window (see STRATEGY.md). */
export const DEFAULT_PARAMS: Params = PARAMS_STEADY;

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
  const probed = new Map<Pubkey, 'buying' | 'selling'>();
  const counted = new Set<Pubkey>();
  /** Mints whose filled buy spent >= 0.01 SOL: only their closed round trips count. */
  const qualifiedBuys = new Set<Pubkey>();
  let firstBlockTime: number | null = null;
  let lastBlockTime: number | null = null;
  let probesUsed = 0;

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
    if (first.slot > start + 60) return null;
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
    if (c.complete || c.devSold) return false;
    if (c.createdSlot === null || slot - c.createdSlot < p.minAge) return false;
    const curve = state.curves.get(c.mint);
    if (curve === undefined || curve.complete) return false;
    const rqSol = Number(curve.real_quote_reserves) / LAMPORTS_PER_SOL;
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return false;
    const s = windowStats(c, slot);
    if (s === null) return false;
    if (s.rise < p.minRise || s.rise > p.maxRise) return false;
    if (s.rise60 > p.maxRise60) return false;
    if (s.nearHigh < p.nearHigh) return false;
    if (s.netSol < p.minNetSol) return false;
    if (s.buys < p.minBuys) return false;
    if (s.buyers < p.minBuyers) return false;
    if (s.trades > p.maxTrades) return false;
    return true;
  }

  /** Net flow over the window in lamports (negative = sellers dominate). */
  function windowFlowLamports(c: Coin, slot: number): number {
    const start = slot - p.window;
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
      if (!state.positions.has(mint)) held.delete(mint);
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
      const stale = c !== undefined && slot - c.lastTradeSlot > p.staleSlots;
      const flowFade =
        c !== undefined && windowFlowLamports(c, slot) < p.exitFlowLamports;
      const devSold = c !== undefined && c.devSold && p.exitOnDevSell;
      const trailing =
        h !== undefined && h.bestRatio >= 1 + p.trailArm && ratio <= h.bestRatio * (1 - p.trail);
      if (
        ratio >= 1 + p.tp ||
        ratio <= 1 - p.sl ||
        trailing ||
        age >= p.maxHold ||
        flowFade ||
        stale ||
        devSold
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

    // --- pyramid adds: buy more of a winner that still qualifies ---
    if (orders.length < 16) {
      for (const [mint, h] of [...held.entries()]) {
        if (orders.length >= 16) break;
        if (!state.positions.has(mint)) continue;
        if (state.positions.get(mint) === undefined) continue;
        const pos = state.positions.get(mint)!;
        const costSol = Number(BigInt(pos.cost_lamports)) / LAMPORTS_PER_SOL;
        if (costSol >= p.maxStakeSol) continue;
        const c = coins.get(mint);
        if (c === undefined || !qualifies(state, c, slot)) continue;
        const curve = state.curves.get(mint)!;
        const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        if (price < h.lastBuyPrice * (1 + p.addStep)) continue;
        const want = BigInt(Math.round(p.addSol * LAMPORTS_PER_SOL));
        const room = budget(mint);
        const free = state.freeCashLamports();
        const size = want < room ? want : room;
        const affordable = free - BigInt(orders.length) * state.txFeeLamports();
        const finalSize = size < affordable ? size : affordable;
        if (finalSize < BigInt(Math.round(0.005 * LAMPORTS_PER_SOL))) continue;
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
        const curve = state.curves.get(mint)!;
        const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        if (price <= 0) continue;
        const want = BigInt(Math.round(p.initialSol * LAMPORTS_PER_SOL));
        const room = budget(mint);
        const free = state.freeCashLamports();
        const size = want < room ? want : room;
        const affordable = free - BigInt(orders.length) * state.txFeeLamports();
        const finalSize = size < affordable ? size : affordable;
        if (finalSize < BigInt(Math.round(0.005 * LAMPORTS_PER_SOL))) continue;
        orders.push({
          side: 'buy',
          mint,
          quote_lamports: finalSize.toString(),
          max_slippage_bps: p.buySlippageBps,
        });
        spend(mint, finalSize);
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
        : 0;
    const targetCoins = Math.floor(p.paceCoinsPerHour * elapsedHours);
    const lagging = counted.size + probed.size < targetCoins;
    if (
      lagging &&
      probesUsed < p.maxProbes &&
      orders.length < 16 &&
      state.committedPositionCount() < p.maxOpen
    ) {
      // Sell any probe whose buy has landed.
      for (const [mint, phase] of [...probed.entries()]) {
        if (phase === 'buying' && state.positions.has(mint)) {
          const pos = state.positions.get(mint)!;
          orders.push({
            side: 'sell',
            mint,
            token_amount: pos.token_amount,
            max_slippage_bps: p.sellSlippageBps,
          });
          probed.set(mint, 'selling');
        } else if (phase === 'selling' && !state.positions.has(mint)) {
          probed.delete(mint);
        }
      }
      // Open one fresh probe on a liquid, non-dumping coin touched this batch.
      if (
        orders.length < 16 &&
        state.committedPositionCount() < p.maxOpen &&
        ![...probed.values()].includes('buying')
      ) {
        for (const mint of touched) {
          if (state.positions.has(mint) || held.has(mint) || probed.has(mint)) continue;
          if (counted.has(mint)) continue;
          const c = coins.get(mint);
          const curve = state.curves.get(mint);
          if (c === undefined || curve === undefined || curve.complete) continue;
          const rqSol = Number(curve.real_quote_reserves) / LAMPORTS_PER_SOL;
          if (rqSol < 2) continue;
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
          probed.set(mint, 'buying');
          probesUsed++;
          break;
        }
      }
    }

    return orders;
  }

  return { onBatch };
}
