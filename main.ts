// Sharpe-sprint rider: a quiet-momentum paper bot for the agent-fun pump.fun
// replay (agent-fun/replay/v2). Ranked by hourly Sharpe ratio on a 6-hour
// forward window, so it trades mature coins on quiet momentum with steady
// take-profit / trailing-stop exits and a probe pacer that keeps the 20-coin
// guardrail met. The grader runs `node main.ts`; the strategy lives in
// strategy.ts and the SDK shim is the kit's sdk/ts/makefun-bot.ts, vendored
// byte for byte under vendor/.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
