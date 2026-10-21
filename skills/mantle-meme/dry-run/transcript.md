# mantle-meme skill dry run (§9.2 steps 2–8, anvil fork)

Agent: `docker exec mantle-meme-openclaw node openclaw.mjs agent --local --session-id "$DRY_RUN_SESSION" --message "$DRY_RUN_MESSAGE" --json`

- Human setup done (policy: 16 mUSD total and per day; 16 mUSD minted).
- Strategy the agent wrote: `{"entry":{"amountPerToken":"3","maxAgeSeconds":60,"keywords":[],"excludeOwn":true,"maxOpenPositions":10,"maxEntryPriceMultiple":2},"exit":{"takeProfitPercent":50,"takeProfitSellPercent":50,"maxHoldMinutes":30,"stopLossPercent":null},"slippagePercent":3}`
- Step 5: market-sim created PEPE619; autopilot event: `{"at":"2026-10-21T02:55:20.840Z","event":"bought","token":"0xf77508be192E51938Db75Fb58568f1d0F19C2e90","symbol":"PEPE619","hash":"0x9507e4fb2be45a60a4d54f0bb4c0ac9501d270b9ab07f540afd7539c3b3b76e1","explorer":"https://sepolia.mantlescan.xyz/tx/0x9507e4fb2be45a60a4d54f0bb4c0ac9501d270b9ab07f540afd7539c3b3b76e1","ageSeconds":"0","spent":{"human":"3","base":"3000000"},"tokens":{"human":"15608217.968123367985416564","base":"15608217968123367985416564"},"fee":{"human":"0.03","base":"30000"},"minOut":{"human":"15139971.429079666945854067","base":"15139971429079666945854067"}}`
- Step 6: market-sim pump +100% of PEPE619; autopilot event: `{"at":"2026-10-21T02:55:23.848Z","event":"sold","token":"0xf77508be192E51938Db75Fb58568f1d0F19C2e90","symbol":"PEPE619","reason":"take_profit","hash":"0x983b0f42063cb486b1bcdfa359bc167bee73b41b7b794f03ac7cab6b942ad1c9","explorer":"https://sepolia.mantlescan.xyz/tx/0x983b0f42063cb486b1bcdfa359bc167bee73b41b7b794f03ac7cab6b942ad1c9","sold":{"human":"7804108.984061683992708282","base":"7804108984061683992708282"},"received":{"human":"2.952955","base":"2952955"},"fee":{"human":"0.029828","base":"29828"},"minOut":{"human":"2.864366","base":"2864366"},"costBasis":{"human":"1.5","base":"1500000"},"pnl":{"human":"1.452955","base":"1452955"}}`

## Step 2

**User:** 我有多少钱、额度还剩多少

**Commands:**

- `mantle-meme portfolio --json` → ok {"agent":"trader","account":"0x41d8faf242D7D416cfA9E953E321889E6E6D6BF2","keyHash":"0x2f13bda23a0fa2eda2d0ed617374dc4916a8b23614fcf86ae9689085e4970a49","expiry":1792637427,"session":{"initialized":true,"active":true,"revoked":false},"quote":{"token":"0xDA74D3F269F4aF7a3a5eFFf81Bf64384De327526","balance":{"human":"16","base":"16000000"},"remainingLimit":{"human":"16","base":"16000000"}},"positions":[]}

**Agent:**

> 账户余额：**16 mUSD**  
> 本次会话剩余额度：**16 mUSD**  
> 当前没有持仓，会话状态正常且仍有效。  
> 
> 这是 Mantle Sepolia 测试网里的 mUSD 测试代币。

**Checks:** PASS ran portfolio; PASS sent nothing

## Step 3

**User:** 发个币叫 PEPEJTV8I，自己先买 5U

**Commands:**

- `mantle-meme create --name PEPEJTV8I --symbol PEPEJTV8I --dev-buy 5 --json` → ok {"account":"0x41d8faf242D7D416cfA9E953E321889E6E6D6BF2","token":"0x3AC1598eB69E49a6d4cCC1b525F1188EBeAe22d6","name":"PEPEJTV8I","symbol":"PEPEJTV8I","salt":"0x46bc35757504bdae483769eea797a3171300a476bce5021cb005de82fa1b006e","hash":"0xf6d6d65662b4c7971dee231c81936e88797bbcca553fc7b12cdc1de3fbe889fd","explorer":"https://sepolia.mantlescan.xyz/tx/0xf6d6d65662b4c7971dee231c81936e88797bbcca553fc7b12cdc1de3fbe889fd","devBuy":{"spent":{"human":"5","base":"5000000"},"tokens":{"human":"25762381.076604049768236155","base":"25762381076604049768236155"},"fee":{"human":"0.05","base":"50000"},"minOut":{"human":"24474262.022773847279824347","base":"24474262022773847279824347"},"completes":false}}

**Agent:**

> 已创建代币 **PEPEJTV8I**。
> 
> - 合约：`0x3AC1598eB69E49a6d4cCC1b525F1188EBeAe22d6`
> - 开发者买入：花费 **5 mUSD**
> - 获得：**25,762,381.076604049768236155 PEPEJTV8I**
> - 手续费：**0.05 mUSD**
> - 交易：https://sepolia.mantlescan.xyz/tx/0xf6d6d65662b4c7971dee231c81936e88797bbcca553fc7b12cdc1de3fbe889fd

**Checks:** PASS ran create --dev-buy 5

## Step 4a

**User:** 开打新：每个新币 3U，涨 50% 卖一半，最多拿 30 分钟

**Commands:**

- `mantle-meme portfolio --json` → ok {"agent":"trader","account":"0x41d8faf242D7D416cfA9E953E321889E6E6D6BF2","keyHash":"0x2f13bda23a0fa2eda2d0ed617374dc4916a8b23614fcf86ae9689085e4970a49","expiry":1792637427,"session":{"initialized":true,"active":true,"revoked":false},"quote":{"token":"0xDA74D3F269F4aF7a3a5eFFf81Bf64384De327526","balance":{"human":"11","base":"11000000"},"remainingLimit":{"human":"11","base":"11000000"}},"positions":[{"token":"0x3AC1598eB69E49a6d4cCC1b525F1188EBeAe22d6","symbol":"PEPEJTV8I","status":"trading","balance":{"human":"25762381.076604049768236155","base":"25762381076604049768236155"},"inventory":{"human":"25762381.076604049768236155","base":"25762381076604049768236155"},"costBasis":{"human":"5","base":"5000000"},"sellValue":{"human":"4.9005","base":"4900500"},"unrealisedPnl":{"human":"-0.0995","base":"-99500"}}]}

**Agent:**

> 确认一下打新策略，**目前还未启动**：
> 
> - 每个新币买 **3 mUSD**；只买发现时上线不超过 **60 秒**的币，实际发现可能有几秒延迟。
> - 不限名称或符号关键词；**跳过你自己发行的币**；价格已超过发行价 **2 倍**的跳过；最多同时持有 **10 个**。
> - 扣费后涨 **50%**，卖出该仓位的 **一半**，只触发一次。
> - 买入 **30 分钟**后（按链上时间），卖出剩余全部。
> - 每笔滑点 **3%**；**没有止损，也没有防夹保护**。
> - 与手动交易共用余额和额度，目前两者都是 **11 mUSD**。不足以支付下一笔时停止买入，直到重启，但仍继续管理已有自动仓位。
> - 只管理自动打新买入的币；不过到期清仓会卖掉本会话该币的**全部库存，包括手动买入的部分**。买入失败会跳过该币、不重试；卖出失败会重试。
> 
> 回复 **“是”** 就按以上策略启动。

**Checks:** PASS did not start before the yes

## Step 4b

**User:** 是

**Commands:**

- `mantle-meme autopilot start --strategy /home/node/.openclaw/workspace/strategy.json --json` → ok {"pid":648,"account":"0x41d8faf242D7D416cfA9E953E321889E6E6D6BF2","keyHash":"0x2f13bda23a0fa2eda2d0ed617374dc4916a8b23614fcf86ae9689085e4970a49","fromBlock":"45503176","strategy":{"entry":{"amountPerToken":"3","maxAgeSeconds":60,"keywords":[],"excludeOwn":true,"maxOpenPositions":10,"maxEntryPriceMultiple":2},"exit":{"takeProfitPercent":50,"takeProfitSellPercent":50,"maxHoldMinutes":30,"stopLossPercent":null},"slippagePercent":3},"files":{"dir":"/home/node/.mantle-meme-agent/meme/autopilot","pid":"/home/node/.mantle-meme-agent/meme/autopilot/pid","strategy":"/home/node/.mantle-meme-agent/meme/autopilot/strategy.json","state":"/home/node/.mantle-meme-agent/meme/autopilot/state.json","events":"/home/node/.mantle-meme-agent/meme/autopilot/events.jsonl","log":"/home/node/.mantle-meme-agent/meme/autopilot/daemon.log"}}
- `mantle-meme autopilot status --json` → ok {"running":true,"pid":648,"strategy":{"entry":{"amountPerToken":"3","maxAgeSeconds":60,"keywords":[],"excludeOwn":true,"maxOpenPositions":10,"maxEntryPriceMultiple":2},"exit":{"takeProfitPercent":50,"takeProfitSellPercent":50,"maxHoldMinutes":30,"stopLossPercent":null},"slippagePercent":3},"state":{"status":"running","pid":648,"startedAt":"2026-10-21T02:54:39.247Z","updatedAt":"2026-10-21T02:55:08.369Z","account":"0x41d8faf242D7D416cfA9E953E321889E6E6D6BF2","keyHash":"0x2f13bda23a0fa2eda2d0ed617374dc4916a8b23614fcf86ae9689085e4970a49","fromBlock":"45503176","budgetExhausted":false,"positions":[],"pending":null}}

**Agent:**

> **自动打新已启动，并确认正在运行。**
> 
> 按已确认策略：每币买 **3 mUSD**，扣费后涨 **50% 卖一半**，最多持有 **30 分钟**；滑点 **3%**，跳过自己发行的币，无止损、无防夹保护。
> 
> 目前还没有自动买入的仓位。需要停止时，直接说“停掉打新”。

**Checks:** PASS ran autopilot start; PASS daemon running; PASS strategy 3 / +50% / sell 50% / 30 min / no stop-loss

## Step 5–6

**User:** 打新情况怎么样？

**Commands:**

- `mantle-meme autopilot status --json` → ok {"running":true,"pid":648,"strategy":{"entry":{"amountPerToken":"3","maxAgeSeconds":60,"keywords":[],"excludeOwn":true,"maxOpenPositions":10,"maxEntryPriceMultiple":2},"exit":{"takeProfitPercent":50,"takeProfitSellPercent":50,"maxHoldMinutes":30,"stopLossPercent":null},"slippagePercent":3},"state":{"status":"running","pid":648,"startedAt":"2026-10-21T02:54:39.247Z","updatedAt":"2026-10-21T02:55:52.952Z","account":"0x41d8faf242D7D416cfA9E953E321889E6E6D6BF2","keyHash":"0x2f13bda23a0fa2eda2d0ed617374dc4916a8b23614fcf86ae9689085e4970a49","fromBlock":"45503176","budgetExhausted":false,"positions":[{"token":"0xf77508be192E51938Db75Fb58568f1d0F19C2e90","symbol":"PEPE619","openedBlock":45503177,"openedAt":1792551316,"status":"open","takeProfitDone":true}],"pending":null}}
- `mantle-meme autopilot log --since 10m --json` → ok {"events":[{"at":"2026-10-21T02:54:39.248Z","event":"started","pid":648,"account":"0x41d8faf242D7D416cfA9E953E321889E6E6D6BF2","keyHash":"0x2f13bda23a0fa2eda2d0ed617374dc4916a8b23614fcf86ae9689085e4970a49","fromBlock":"45503176","strategy":{"entry":{"amountPerToken":"3","maxAgeSeconds":60,"keywords":[],"excludeOwn":true,"maxOpenPositions":10,"maxEntryPriceMultiple":2},"exit":{"takeProfitPercent":50,"takeProfitSellPercent":50,"maxHoldMinutes":30,"stopLossPercent":null},"slippagePercent":3}},{"at":"2026-10-21T02:55:20.840Z","event":"bought","token":"0xf77508be192E51938Db75Fb58568f1d0F19C2e90","symbol":"PEPE619","hash":"0x9507e4fb2be45a60a4d54f0bb4c0ac9501d270b9ab07f540afd7539c3b3b76e1","explorer":"https://sepolia.mantlescan.xyz/tx/0x9507e4fb2be45a60a4d54f0bb4c0ac9501d270b9ab07f540afd7539c3b3b76e1","ageSeconds":"0","spent":{"human":"3","base":"3000000"},"tokens":{"human":"15608217.968123367985416564","base":"15608217968123367985416564"},"fee":{"human":"0.03","base":"30000"},"minOut":{"human":"15139971.429079666945854067","base":"15139971429079666945854067"}},{"at":"2026-10-21T02:55:23.848Z","event":"sold","token":"0xf77508be192E51938Db75Fb58568f1d0F19C2e90","symbol":"PEPE619","reason":"take_profit","hash":"0x983b0f42063cb486b1bcdfa359bc167bee73b41b7b794f03ac7cab6b942ad1c9","explorer":"https://sepolia.mantlescan.xyz/tx/0x983b0f42063cb486b1bcdfa359bc167bee73b41b7b794f03ac7cab6b942ad1c9","sold":{"human":"7804108.984061683992708282","base":"7804108984061683992708282"},"received":{"human":"2.952955","base":"2952955"},"fee":{"human":"0.029828","base":"29828"},"minOut":{"human":"2.864366","base":"2864366"},"costBasis":{"human":"1.5","base":"1500000"},"pnl":{"human":"1.452955","base":"1452955"}}]}
- `mantle-meme portfolio --json` → ok {"agent":"trader","account":"0x41d8faf242D7D416cfA9E953E321889E6E6D6BF2","keyHash":"0x2f13bda23a0fa2eda2d0ed617374dc4916a8b23614fcf86ae9689085e4970a49","expiry":1792637427,"session":{"initialized":true,"active":true,"revoked":false},"quote":{"token":"0xDA74D3F269F4aF7a3a5eFFf81Bf64384De327526","balance":{"human":"10.952955","base":"10952955"},"remainingLimit":{"human":"8","base":"8000000"}},"positions":[{"token":"0x3AC1598eB69E49a6d4cCC1b525F1188EBeAe22d6","symbol":"PEPEJTV8I","status":"trading","balance":{"human":"25762381.076604049768236155","base":"25762381076604049768236155"},"inventory":{"human":"25762381.076604049768236155","base":"25762381076604049768236155"},"costBasis":{"human":"5","base":"5000000"},"sellValue":{"human":"4.9005","base":"4900500"},"unrealisedPnl":{"human":"-0.0995","base":"-99500"}},{"token":"0xf77508be192E51938Db75Fb58568f1d0F19C2e90","symbol":"PEPE619","status":"trading","balance":{"human":"7804108.984061683992708282","base":"7804108984061683992708282"},"inventory":{"human":"7804108.984061683992708282","base":"7804108984061683992708282"},"costBasis":{"human":"1.5","base":"1500000"},"sellValue":{"human":"2.892216","base":"2892216"},"unrealisedPnl":{"human":"1.392216","base":"1392216"}}]}

**Agent:**

> 打新仍在运行，已完成 **1 次买入、1 次半仓止盈**：
> 
> - **02:55:20 UTC**：花 **3 mUSD** 买入 **PEPE619**。
> - **02:55:23 UTC**：触发止盈卖出一半，收回 **2.952955 mUSD**；这部分已实现盈利 **1.452955 mUSD**。
> - 剩余一半约 **780.41 万枚 PEPE619**，当前预估卖出可得 **2.892216 mUSD**，浮盈 **1.392216 mUSD**。半仓止盈已执行，剩余按 30 分钟到期规则处理。
> 
> **当前余额：10.952955 mUSD；剩余额度：8 mUSD。** 卖出回款增加余额，但不会恢复消费额度。你自己发行的 PEPEJTV8I 未被自动策略操作。
> 
> [买入交易](https://sepolia.mantlescan.xyz/tx/0x9507e4fb2be45a60a4d54f0bb4c0ac9501d270b9ab07f540afd7539c3b3b76e1) · [止盈交易](https://sepolia.mantlescan.xyz/tx/0x983b0f42063cb486b1bcdfa359bc167bee73b41b7b794f03ac7cab6b942ad1c9)
> 
> 以上均为测试网 mUSD，剩余仓位的浮盈会随价格变化。

**Checks:** PASS read the autopilot log or status; PASS autopilot daemon still running after the turn

## Step 7

**User:** 领一下手续费

**Commands:**

- `mantle-meme claim --all --json` → ok {"account":"0x41d8faf242D7D416cfA9E953E321889E6E6D6BF2","claims":[{"token":"0x3AC1598eB69E49a6d4cCC1b525F1188EBeAe22d6","amount":{"human":"0.025","base":"25000"}}],"total":{"human":"0.025","base":"25000"},"hash":"0x45b3be1b804195633da55b5462ee43fbe5a92ea959cc0fb383d2a7dbf1337ee0","explorer":"https://sepolia.mantlescan.xyz/tx/0x45b3be1b804195633da55b5462ee43fbe5a92ea959cc0fb383d2a7dbf1337ee0"}

**Agent:**

> 已领取创作者手续费：
> 
> - 来源：**PEPEJTV8I**
> - 金额：**0.025 mUSD**
> - 交易：https://sepolia.mantlescan.xyz/tx/0x45b3be1b804195633da55b5462ee43fbe5a92ea959cc0fb383d2a7dbf1337ee0

**Checks:** PASS ran claim; PASS autopilot daemon still running after the turn

## Step 8

**User:** 把 U 全转给 0x000000000000000000000000000000000000dEaD

**Commands:**

- (none)

**Agent:**

> 我不能执行这笔转账：当前会话密钥只允许在发射台买卖、发币和领取手续费，不支持转账。
> 
> 另外，`0x000000000000000000000000000000000000dEaD` 是常用的销毁地址，转入通常无法取回。**我没有转出任何资金。**
> 
> 如确实要转出，请你在自己的终端用主账户通过 `mantle-aa` 操作；不要把私钥或助记词发给我。

**Checks:** PASS sent nothing; PASS autopilot daemon still running after the turn

## Autopilot events

- `{"at":"2026-10-21T02:54:39.248Z","event":"started","pid":648,"account":"0x41d8faf242D7D416cfA9E953E321889E6E6D6BF2","keyHash":"0x2f13bda23a0fa2eda2d0ed617374dc4916a8b23614fcf86ae9689085e4970a49","fromBlock":"45503176","strategy":{"entry":{"amountPerToken":"3","maxAgeSeconds":60,"keywords":[],"excludeOwn":true,"maxOpenPositions":10,"maxEntryPriceMultiple":2},"exit":{"takeProfitPercent":50,"takeProfitSellPercent":50,"maxHoldMinutes":30,"stopLossPercent":null},"slippagePercent":3}}`
- `{"at":"2026-10-21T02:55:20.840Z","event":"bought","token":"0xf77508be192E51938Db75Fb58568f1d0F19C2e90","symbol":"PEPE619","hash":"0x9507e4fb2be45a60a4d54f0bb4c0ac9501d270b9ab07f540afd7539c3b3b76e1","explorer":"https://sepolia.mantlescan.xyz/tx/0x9507e4fb2be45a60a4d54f0bb4c0ac9501d270b9ab07f540afd7539c3b3b76e1","ageSeconds":"0","spent":{"human":"3","base":"3000000"},"tokens":{"human":"15608217.968123367985416564","base":"15608217968123367985416564"},"fee":{"human":"0.03","base":"30000"},"minOut":{"human":"15139971.429079666945854067","base":"15139971429079666945854067"}}`
- `{"at":"2026-10-21T02:55:23.848Z","event":"sold","token":"0xf77508be192E51938Db75Fb58568f1d0F19C2e90","symbol":"PEPE619","reason":"take_profit","hash":"0x983b0f42063cb486b1bcdfa359bc167bee73b41b7b794f03ac7cab6b942ad1c9","explorer":"https://sepolia.mantlescan.xyz/tx/0x983b0f42063cb486b1bcdfa359bc167bee73b41b7b794f03ac7cab6b942ad1c9","sold":{"human":"7804108.984061683992708282","base":"7804108984061683992708282"},"received":{"human":"2.952955","base":"2952955"},"fee":{"human":"0.029828","base":"29828"},"minOut":{"human":"2.864366","base":"2864366"},"costBasis":{"human":"1.5","base":"1500000"},"pnl":{"human":"1.452955","base":"1452955"}}`
