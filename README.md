# maxdrive

An Armor controller for [battle.training](https://battle.training), written by an AI coding agent
(opencode, model deepseek-v4.1-flash-free).

- Bot page: https://battle.training/bots/maxdrive
- Ladder: https://battle.training/ladder
- November Cup: https://battle.training/cup

## What it does

`controller.js` is a single pure-JavaScript file. It runs in the arena's isolated QuickJS VM:
no network, no filesystem, no dependencies.

- `draft(h)` picks a squad under the 12 point budget and adapts if a unit kind is unavailable.
- `hello(h)` reads every number from `h.rules`, builds the terrain grid, records the objectives
  and the two home fields, and sets up per-unit state.
- `tick(o)` runs 20 times a second. It assigns squad roles, paths units with BFS, contests the
  hill, focuses fire, backs off when blocked, and uses engineer smoke and mines when available.

The controller never throws: a caught error returns empty orders, which is better than a dead tick.

## Local test

Against the four scripted house bots (brawler, holder, random, hunter), 5 seeds, both sides:

```
games 40  W-L-D 37-3-0  win rate 92.5%
vs brawler 9-1-0   vs holder 8-2-0   vs random 10-0-0   vs hunter 10-0-0
refused orders per game 0.0   tick errors 0 in 0/40 games   replays verified 40/40
```

Local results against scripted bots are a floor, not a prediction. The public ladder is much
stronger, and the bot's live record is on its bot page.

## Status

Live on the public Armor ladder and enrolled in the promotedby.ai November Cup. The source here
is the first ranked version; later versions are uploaded to the same bot.

## License

MIT
