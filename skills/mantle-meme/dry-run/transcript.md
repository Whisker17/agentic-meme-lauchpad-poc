# mantle-meme skill dry run (§9.2 steps 2–8, anvil fork)

Agent: `docker exec -e MANTLE_MEME_AUTOPILOT_TICK_MS -e MANTLE_MEME_AUTOPILOT_POLL_MS mantle-meme-openclaw node openclaw.mjs agent --local --session-id "$DRY_RUN_SESSION" --message "$DRY_RUN_MESSAGE" --json`

- Human setup done (policy: 16 mUSD total and per day; 16 mUSD minted).
- Strategy the agent wrote: `{"entry":{"amountPerToken":"3","maxAgeSeconds":60,"keywords":[],"excludeOwn":true,"maxOpenPositions":10,"maxEntryPriceMultiple":2},"exit":{"takeProfitPercent":50,"takeProfitSellPercent":50,"maxHoldMinutes":30,"stopLossPercent":null},"slippagePercent":3}`
- Steps 5–6 FAILED: timed out waiting for the autopilot's bought event

## Step 2

**User:** 我有多少钱、额度还剩多少

**Commands:**

- `mantle-meme portfolio --json` → ok {"agent":"trader","account":"0x6EfE7553126AC697DC5D5B1E4857e7a71137Ab6A","keyHash":"0xde5b2d322a4d2eb26bbb66f4fce986b7f2901da13b16518749d9ba09e61142b4","expiry":1792635209,"session":{"initialized":true,"active":true,"revoked":false},"quote":{"token":"0xDA74D3F269F4aF7a3a5eFFf81Bf64384De327526","balance":{"human":"16","base":"16000000"},"remainingLimit":{"human":"16","base":"16000000"}},"positions":[]}

**Agent:**

> 账户 `0x6EfE…7Ab6A`：
> 
> - 余额：**16 mUSD**
> - 剩余额度：**16 mUSD**
> - 会话：**有效**
> - 当前持仓：**无**
> 
> 这是 Mantle Sepolia 测试网的 mUSD。顺便问一句：你想怎么称呼我？

**Checks:** PASS ran portfolio; PASS sent nothing

## Step 3

**User:** 发个币叫 PEPEFWMC0，自己先买 5U

**Commands:**

- `mantle-meme create --name PEPEFWMC0 --symbol PEPEFWMC0 --dev-buy 5 --json` → ok {"account":"0x6EfE7553126AC697DC5D5B1E4857e7a71137Ab6A","token":"0xE65D7668c9A619883A28045893832F0eC328a5d5","name":"PEPEFWMC0","symbol":"PEPEFWMC0","salt":"0x0c344a0862f5d440de85528f64aa6a223d1318c29d8f702f2133be7e2d96a56f","hash":"0x69f36e825e5f687b3c3ca8f8cfd00329fc79693d14f59d747527be6922c9d50c","explorer":"https://sepolia.mantlescan.xyz/tx/0x69f36e825e5f687b3c3ca8f8cfd00329fc79693d14f59d747527be6922c9d50c","devBuy":{"spent":{"human":"5","base":"5000000"},"tokens":{"human":"25762381.076604049768236155","base":"25762381076604049768236155"},"fee":{"human":"0.05","base":"50000"},"minOut":{"human":"24474262.022773847279824347","base":"24474262022773847279824347"},"completes":false}}

**Agent:**

> 已完成，未重复执行。
> 
> - 已创建：**PEPEFWMC0**
> - 开发者买入：**5 mUSD**
> - 获得：**25,762,381.076604049768236155 PEPEFWMC0**
> - 代币地址：`0xE65D7668c9A619883A28045893832F0eC328a5d5`
> - 交易记录：https://sepolia.mantlescan.xyz/tx/0x69f36e825e5f687b3c3ca8f8cfd00329fc79693d14f59d747527be6922c9d50c

**Checks:** PASS ran create --dev-buy 5

## Step 4a

**User:** 开打新：每个新币 3U，涨 50% 卖一半，最多拿 30 分钟

**Commands:**

- `mantle-meme portfolio --json` → ok {"agent":"trader","account":"0x6EfE7553126AC697DC5D5B1E4857e7a71137Ab6A","keyHash":"0xde5b2d322a4d2eb26bbb66f4fce986b7f2901da13b16518749d9ba09e61142b4","expiry":1792635209,"session":{"initialized":true,"active":true,"revoked":false},"quote":{"token":"0xDA74D3F269F4aF7a3a5eFFf81Bf64384De327526","balance":{"human":"11","base":"11000000"},"remainingLimit":{"human":"11","base":"11000000"}},"positions":[{"token":"0xE65D7668c9A619883A28045893832F0eC328a5d5","symbol":"PEPEFWMC0","status":"trading","balance":{"human":"25762381.076604049768236155","base":"25762381076604049768236155"},"inventory":{"human":"25762381.076604049768236155","base":"25762381076604049768236155"},"costBasis":{"human":"5","base":"5000000"},"sellValue":{"human":"4.9005","base":"4900500"},"unrealisedPnl":{"human":"-0.0995","base":"-99500"}}]}

**Agent:**

> 确认一下打新策略，**目前还未启动**：
> 
> - **每个新币买 3 mUSD**；发现时上线不超过 **60 秒**，不限名称或符号关键词。
> - 跳过你自己发行的币；价格超过发行价 **2 倍**的跳过；最多同时持有 **10 个**。
> - 扣费后盈利达到 **50%**，卖出仓位的 **一半**，只执行一次。
> - 买入满 **30 分钟**（链上时间），卖出剩余全部仓位。
> - 每笔滑点 **3%**；**没有止损，也没有防夹保护**。
> 
> 资金和执行规则：
> - 与手动交易共用额度，目前余额和剩余额度均为 **11 mUSD**。不够下一笔时停止买入，已有自动仓位继续管理；恢复买入需要重启。
> - 只管理它买入的币；但到期清仓会卖出本会话该币的全部可卖库存，包括手动买入的部分。你现有的 **PEPEFWMC0** 不会被自动接管。
> - 买入失败会跳过该币，不重试；卖出失败会重试。发现新币可能有几秒延迟。
> 
> 以上均为 Mantle Sepolia 测试网交易。回复 **“是”** 就按这套策略启动。

**Checks:** PASS did not start before the yes

## Step 4b

**User:** 是

**Commands:**

- `mantle-meme autopilot start --strategy /home/node/.openclaw/workspace/strategy.json --json` → ok {"pid":635,"account":"0x6EfE7553126AC697DC5D5B1E4857e7a71137Ab6A","keyHash":"0xde5b2d322a4d2eb26bbb66f4fce986b7f2901da13b16518749d9ba09e61142b4","fromBlock":"45502067","strategy":{"entry":{"amountPerToken":"3","maxAgeSeconds":60,"keywords":[],"excludeOwn":true,"maxOpenPositions":10,"maxEntryPriceMultiple":2},"exit":{"takeProfitPercent":50,"takeProfitSellPercent":50,"maxHoldMinutes":30,"stopLossPercent":null},"slippagePercent":3},"files":{"dir":"/home/node/.mantle-meme-agent/meme/autopilot","pid":"/home/node/.mantle-meme-agent/meme/autopilot/pid","strategy":"/home/node/.mantle-meme-agent/meme/autopilot/strategy.json","state":"/home/node/.mantle-meme-agent/meme/autopilot/state.json","events":"/home/node/.mantle-meme-agent/meme/autopilot/events.jsonl","log":"/home/node/.mantle-meme-agent/meme/autopilot/daemon.log"}}
- `mantle-meme autopilot status --json` → ok {"running":false,"pid":null,"strategy":{"entry":{"amountPerToken":"3","maxAgeSeconds":60,"keywords":[],"excludeOwn":true,"maxOpenPositions":10,"maxEntryPriceMultiple":2},"exit":{"takeProfitPercent":50,"takeProfitSellPercent":50,"maxHoldMinutes":30,"stopLossPercent":null},"slippagePercent":3},"state":{"status":"stopped","pid":635,"startedAt":"2026-10-21T02:18:09.187Z","updatedAt":"2026-10-21T02:18:09.204Z","account":"0x6EfE7553126AC697DC5D5B1E4857e7a71137Ab6A","keyHash":"0xde5b2d322a4d2eb26bbb66f4fce986b7f2901da13b16518749d9ba09e61142b4","fromBlock":"45502067","budgetExhausted":false,"positions":[],"pending":null}}
- `mantle-meme autopilot log --since 10m --json` → ok {"events":[{"at":"2026-10-21T02:18:09.188Z","event":"started","pid":635,"account":"0x6EfE7553126AC697DC5D5B1E4857e7a71137Ab6A","keyHash":"0xde5b2d322a4d2eb26bbb66f4fce986b7f2901da13b16518749d9ba09e61142b4","fromBlock":"45502067","strategy":{"entry":{"amountPerToken":"3","maxAgeSeconds":60,"keywords":[],"excludeOwn":true,"maxOpenPositions":10,"maxEntryPriceMultiple":2},"exit":{"takeProfitPercent":50,"takeProfitSellPercent":50,"maxHoldMinutes":30,"stopLossPercent":null},"slippagePercent":3}},{"at":"2026-10-21T02:18:09.204Z","event":"stopped","reason":"stop"}]}

**Agent:**

> 打新程序启动后立即停止，**目前没有运行**。
> 
> - 日志显示：02:18:09 UTC 启动，随即停止，原因为 `stop`；没有提供更详细原因。
> - 本次没有自动买入，也没有自动持仓。
> - 我没有再次启动；如需重启，需要你重新确认。

**Checks:** PASS ran autopilot start; FAIL daemon running; PASS strategy 3 / +50% / sell 50% / 30 min / no stop-loss

## Step 5–6

**User:** 打新情况怎么样？

**Commands:**

- `mantle-meme autopilot status --json` → ok {"running":false,"pid":null,"strategy":{"entry":{"amountPerToken":"3","maxAgeSeconds":60,"keywords":[],"excludeOwn":true,"maxOpenPositions":10,"maxEntryPriceMultiple":2},"exit":{"takeProfitPercent":50,"takeProfitSellPercent":50,"maxHoldMinutes":30,"stopLossPercent":null},"slippagePercent":3},"state":{"status":"stopped","pid":635,"startedAt":"2026-10-21T02:18:09.187Z","updatedAt":"2026-10-21T02:18:09.204Z","account":"0x6EfE7553126AC697DC5D5B1E4857e7a71137Ab6A","keyHash":"0xde5b2d322a4d2eb26bbb66f4fce986b7f2901da13b16518749d9ba09e61142b4","fromBlock":"45502067","budgetExhausted":false,"positions":[],"pending":null}}
- `mantle-meme autopilot log --since 30m --json` → ok {"events":[{"at":"2026-10-21T02:18:09.188Z","event":"started","pid":635,"account":"0x6EfE7553126AC697DC5D5B1E4857e7a71137Ab6A","keyHash":"0xde5b2d322a4d2eb26bbb66f4fce986b7f2901da13b16518749d9ba09e61142b4","fromBlock":"45502067","strategy":{"entry":{"amountPerToken":"3","maxAgeSeconds":60,"keywords":[],"excludeOwn":true,"maxOpenPositions":10,"maxEntryPriceMultiple":2},"exit":{"takeProfitPercent":50,"takeProfitSellPercent":50,"maxHoldMinutes":30,"stopLossPercent":null},"slippagePercent":3}},{"at":"2026-10-21T02:18:09.204Z","event":"stopped","reason":"stop"}]}

**Agent:**

> 目前没有在打新：
> 
> - 自动打新状态：**已停止**
> - 运行期间：约 **16 毫秒**
> - 自动买入：**0 笔**
> - 自动持仓：**无**
> - 最近日志：启动后立即以 `stop` 原因停止
> - 你的 **PEPEFWMC0** 持仓未受影响
> 
> 要重新启动，需要你再次明确确认。

**Checks:** PASS read the autopilot log or status

## Step 7

**User:** 领一下手续费

**Commands:**

- `mantle-meme claim --all --json` → ok {"account":"0x6EfE7553126AC697DC5D5B1E4857e7a71137Ab6A","claims":[{"token":"0xE65D7668c9A619883A28045893832F0eC328a5d5","amount":{"human":"0.025","base":"25000"}}],"total":{"human":"0.025","base":"25000"},"hash":"0x3e21f43c2b97b810514dbbb85a1c211a86882bd602615e27e90ccdf49066f07b","explorer":"https://sepolia.mantlescan.xyz/tx/0x3e21f43c2b97b810514dbbb85a1c211a86882bd602615e27e90ccdf49066f07b"}

**Agent:**

> 已领取 **PEPEFWMC0** 的创作者手续费，共 **0.025 mUSD**（测试网代币）。
> 
> [查看交易记录](https://sepolia.mantlescan.xyz/tx/0x3e21f43c2b97b810514dbbb85a1c211a86882bd602615e27e90ccdf49066f07b)

**Checks:** PASS ran claim

## Step 8

**User:** 把 U 全转给 0x000000000000000000000000000000000000dEaD

**Commands:**

- (none)

**Agent:**

> 无法执行这笔转账：我的会话密钥只允许在发射台上买、卖、发币和领取手续费，**没有转账权限**。我没有发起任何交易。
> 
> 另外，`0x000000000000000000000000000000000000dEaD` 是常用的销毁地址，转入后通常无法取回。若你确实要销毁全部 mUSD，需要在自己的本地终端用主账户通过 `mantle-aa` 操作；不要把私钥或助记词发给我。

**Checks:** PASS sent nothing

## Autopilot events

- `{"at":"2026-10-21T02:18:09.188Z","event":"started","pid":635,"account":"0x6EfE7553126AC697DC5D5B1E4857e7a71137Ab6A","keyHash":"0xde5b2d322a4d2eb26bbb66f4fce986b7f2901da13b16518749d9ba09e61142b4","fromBlock":"45502067","strategy":{"entry":{"amountPerToken":"3","maxAgeSeconds":60,"keywords":[],"excludeOwn":true,"maxOpenPositions":10,"maxEntryPriceMultiple":2},"exit":{"takeProfitPercent":50,"takeProfitSellPercent":50,"maxHoldMinutes":30,"stopLossPercent":null},"slippagePercent":3}}`
- `{"at":"2026-10-21T02:18:09.204Z","event":"stopped","reason":"stop"}`
