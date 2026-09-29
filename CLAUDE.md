# CLAUDE.md

给接手这个仓库的人(或 agent)看的项目笔记。**保持简短。**

## 这是什么

DSH 插件,把 OpenCode Go 网关接成一个 provider route(`opencode-go-native`)。
浏览器半边是设置页,宿主半边是适配器 + 一条窄 HTTP 路由。

**核心立场:能力不靠声明,靠实测。** 声明和实测长得一样,混在一起就分不清了。

## 目录

```
src/                 宿主半边(会被 build.mjs 原样复制到 lib/)
  index.js           插件入口:注册 adapter / 设置页 / HTTP 路由
  adapter.js         请求路径:pi-ai 调度、协议回退链、会话头(只解析"当前订阅"那一把 key)
  subs.js            订阅层纯逻辑:归一化({id,label,hidden?})/ 每条自己的槽位派生 / "当前订阅"指针解析
  usage.js           余额层:`GET {base}/usage` 探针 + 落盘($DSH_HOME/opencode-go.usage.json) + TTL 缓存(纯展示)
  subruntime.js      订阅运行时:subs/active/activeKey/keyFor/syncLive/reconcile/refreshAll/refreshStale/rows/view(依赖注入,可裸测)
  protocol-map.js    provider.npm -> 协议 规则,候选链
  sync.js            能力同步引擎(协议/可用性/reasoning 探针)
  synced.js          同步结果的落盘层
  official-baseline.js  models.dev 一手声明的解析与加载(构建期与运行期共用同一套规则)
  official-runtime.js   运行期声明层:新模型现拉 + TTL 重读 + $DSH_HOME 缓存 + 失败回退打包数据
  official-toml.js     自包含 TOML 子集解析器
  catalog.js / snapshot.js   模型集合与 provider.npm 快照
  capabilities.js    声明 -> pi-ai 的能力映射
  base-url.js        normalizeBaseUrl(host-free,config.js 与 subs.js 共用)
  client/            浏览器半边(src/client/** -> lib/client.js)
data/
  opencode-go.official.json   官方能力基线(构建期从 models.dev 生成)
  opencode-go.models.json     只有 name + npm(协议推荐)
tests/               node --test,不需要装 profile
scripts/             获取数据 / 探针 / e2e-active-sub(离线假网关验证"只有一个付款人"+ 唯一的生效变量;旧名 e2e-multi-sub 仍可跑)
```

## 必须守住的不变量

这些每一条都是踩出来的,别顺手改掉:

1. **`requestHeaders(attribution(), …)` 只有一个合并点**,attribution 永远不能少。`tests/session.test.mjs` 静态钉着调用点。
2. **`x-opencode-session` 是网关的必需头**,`/messages` 还要 `x-api-key`,只带 `authorization` 会 401。
3. **`sync.js` 的每发请求必须有超时**(`AbortSignal.timeout`),否则一发挂住整个同步永久卡死。
4. **`headersFor` 展开的是对象**,`syncModel` 收的却是 thunk —— 传错就静默变成空头。
5. **`index.js` 里 `export { x } from './y.js'` 不创建本地绑定**。sync 路由用过 `protocolChainForModel` 却没 import,运行时才炸。`tests/sync.test.mjs` 有静态守卫。
6. **客户端 `catalogueView` 是字段白名单**,新字段不加进去会被静默丢掉(`synced` 就这么丢过一次)。
7. **表格渲染里的 `|` 必须转义**,否则 Markdown 把整行切碎。
8. **`lib/` 提交在仓库里,而且不要加 `prepare` 脚本**。pnpm 会拦 git 包的构建脚本
   (`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`),加 `prepare` 等于让每个装的人都去配 allowBuilds。
   代价是 `lib/` 必须和 `src/` 同步 —— **改完 `src/` 一定要 `npm run build` 并一起提交**,
   提交前跑 `npm run check:lib`(它构建一次再 `git diff --quiet -- lib`,不同步就非零退出)。
9. **`replaceDiscovered` 默认 `true`** —— 全新安装不加载任何模型。它必须和 `src/config.js` 的 schema 默认值保持一致,否则页面和路由对"启用集合"给出不同答案。
10. **`data/opencode-go.models.json` 只放 `name` 和 `npm`**。能力数字一律来自同步,放回来就是制造第二个互相打架的数据源。
11. **官方基线数字只在 `synced.js#composeEntryFaces` 合并**(由 `catalog.snapshotEntryFor` 唯一调用):只合 `contextWindow`/`maxTokens`/`inputModalities` 三个声明类字段,reasoning/protocol/interleavedField 仍归 synced 实测层;`snapshotEnabled: false` 时官方数字随快照面一起关。改这条优先级顺序 = 重新制造 200K 兜底 bug,`tests/official-capability.test.mjs` 钉着。
    **0.9.0 起声明面有两层,但只有一个合并点**:打包的 `data/opencode-go.official.json`(发布期快照 = 离线保底)和
    `official-runtime.js` 运行期拉取的同源记录,后者**写进同一个 document**(`officialRuntime.document`),所以
    `officialRecordFor` / `snapshotEntryFor` / sync 路由读到的永远是合并后的那一份。优先级:
    `models.overrides` > synced 实测 > 运行期声明 > 打包声明 > `defaultContextWindow`。
    运行期层受 `snapshotEnabled` **和** `officialSync` 双重开关(`catalog.#ensureOfficialDeclarations` 里那行
    `if (options.snapshotEnabled !== true || options.officialSync !== true) return`)。
12. **同一时刻只有一个"付款人"(0.8.2)/ 只有一个"生效变量"(0.8.3)**:`options.activeSubscription` 是一个
    **标量指针**,请求路径只解析它指的那一条(`subruntime#activeKey`),发现/同步/目录也用同一把。
    没有池、没有轮换、没有冷却、没有余额闸门——活跃那条失败就**照实报错**,绝不偷偷换成另一条。
    换谁付是操作者的动作(设置页点一行 = 一次 settings 写),`tests/subscriptions-wiring.test.mjs`
    把这几条静态钉住(任何 `pool.*` 回归都会红)。0.8.3 加上**镜像**:顶层 `apiKeyEnv` 是唯一对外可见的
    "生效变量",`reconcile()`(启动 / 每次 settings 变更 / 每次 `/usage` 读)把活跃那条的 key 复制进去;
    复制是**尽力而为**——只读(启动环境提供)就跳过并记在 `projection()` 里,**请求路径读的仍是订阅自己的槽位**,
    所以镜像失败永远不会让请求用错 key。
13. **失败只有一条路要守**:内容块发出之后绝不再试(`if (yielded) throw error`);发出之前失败
    由协议链自己的重试兜底,轮不到"换 key"。旧池会在 error-finish chunk 上换 key,那条路已经删掉。
14. **余额的真相只有网关**:`GET {base}/usage` 按 key 回答 `{rolling,weekly,monthly} × {status,percent,resetsAt}`
    (实测记录在 probe-quota)。本插件**不做本地 token 记账**,而且 0.8.2 起余额**纯粹是展示**:
    请求路径不读它,探测失败只是"这次没刷新"(保留上次读数 + 行上写错误)。探针的 headers 走 `index.js`
    那个唯一合并点(thunk 注入,`usage.js` 里不许出现 `requestHeaders(`)。探针的 baseURL 来自
    `options`(路由事实),不是 sub 自带的字段——订阅只有名字和 key。
    **三个读法,TTL 只住在宿主**:`/usage` 不带 query = 纯缓存;`?refresh=auto` = 只测"上次成功读数比
    `usagePollTtlMs` 更老"的那些行(`refreshStale`),这是**打开面板**要走的路;`?refresh=1` = 全测,不吃 TTL,
    是「刷新余额」按钮这种明确动作。页面**不许自带一份 TTL**(那是操作者可配的设置,第二份就是第二个真相)。
    **没有 key 的行两个模式都不测**(`hasKey`):空槽位背后没有余额,`Bearer undefined` 只会换来 401 并被
    当成网关故障写在行上——而且它曾经把 `refreshAll` 整个循环打断,后面的行一个都测不到。
15. **订阅 = 名字 + key,槽位就用名字,顶层是"生效变量"**:存的 entry 只有 `{ id, label, hidden? }`
    (`apiKeyRef`/`baseURL`/`cap`/`enabled` 一律**报错拒绝**,不静默忽略)。每条的槽位 = `OPENCODE_GO_<名字的 slug>`
    (`me@example.com` → `OPENCODE_GO_ME_EXAMPLE_COM`),**默认那条也一样**(名字取 `displayName`)。
    没名字/名字里没有 A-Z0-9 的行退回 id 派生拼写(老版本存的就是它)。**改名会换槽位**,所以每行都带
    `fallbackRefs` = [id 派生拼写]:`keyFor` 先读自己的槽位、miss 了再读兜底,`reconcile()` 的
    `migrateSlots` 再把值**搬**进当前槽位——改名不丢密钥靠的就是这条链路(单测钉着)。客户端显示/写入的槽位
    必须和宿主派生的一致(vocabulary 测试逐名字对比),而且**任何一行的槽位都不许等于顶层 `apiKeyEnv`**
    (撞上就报错拒绝,否则下一次切换会把它悄悄覆盖掉)。两个同名行 = 同一个槽位 = 直接报错(名字就是地址)。
    **默认订阅是读时合成,永不改写 settings**:`subscriptions` 里出现 `id: 'default'` 只**补丁名字**(顺带把它的
    槽位改成新名字派生);`hidden: true` 是唯一能把它从列表里摘掉的写法(那行是合成的,没有 entry 可删),
    槽位和密钥原样保留,表头给「恢复默认订阅」。**删除规则:当前激活那条不许删**(只剩一条时它就是当前 →
    没有可删的行),其余每行都有删除按钮(禁用态用 tooltip 说明原因)。宿主侧:全 hidden 直接报错;
    active 指向 hidden 时回落到第一条可见订阅。
16. **设置页没有保存按钮(0.8.3)**:改动即写入。普通字段走 ~400ms 防抖(`flushSettings`),**密钥只在
    blur/Enter 写**(`storeRowCredential`),点行/加删订阅/勾选模型当场写。宿主写用一条 promise 队列串行化,
    op 列表**在任务运行时**才算(`queueSettingsWrite`)——否则后一个写会拿着过期的 revision 被宿主判冲突。
    客户端**本地校验不过就不发**(`validateForm`),拦下来的错误必须在页面上有字(渲染不出来的校验错误 =
    表单静默卡死;订阅级报错渲染在标题上方)。`tests/client-bundle.test.mjs` 驱动真实 bundle 钉着这条
    (它也是唯一能证明"页面没坏"的地方)。**点击那条「默认」订阅**也要写指针:`activationWriteOps` 里默认行
    没有 stored entry,早期实现直接返回 `[]`,于是页面显示"当前"而宿主从没收到 —— 现在只有真正的 no-op 才
    返回 `[]`,激活之后还有一次"还脏就 `scheduleFlush(0)`"的兜底。
    **页面别加提示行**:0.8.3 的第一版在页头挂了「改动立即生效…/正在生效…」、在订阅卡下挂了
    「生效变量 …」,实测就是让界面变臃肿——自动保存/生效变量这类机制在点一下就能验证的行为面前不需要解释,
    **卡片抬头显示的是"当前生效那条订阅的名字"**(不是 `displayName`,否则切走之后抬头会和「当前」行自相矛盾)、
    手动「重新载入」只在多标签冲突时由冲突提示给出按钮。
    **一条订阅占两行**:第一行 = 单选点 + 名字 + 「当前」+ 设置/删除,第二行 = 这条 key 的三根余额条,
    每个胶囊**下面**写重置时间(`resetShort`;悬停是 `resetPhrase` + 本地钟点 `resetStamp`)。单行时代名被三根
    进度条挤到几十像素、重置时间也无处安放,所以 `.ocg-meters` 用 `grid-area: 2 / 2 / 3 / -1` 落到名字下面那一行,
    三格 `minmax(72px, 1fr)` 铺满(整张卡 `max-width: 720px`,所以一格最多 ~220px)。**没测过的窗口不写重置行**
    (那个时刻网关根本没报过),`tests/client-bundle.test.mjs` 钉着这两条。
17. **403 不一定是 key 错**:`classifyPiAiError` 先问 `health.js` 的分类,`region` / `data-policy` /
    `country-block` 一律 `UNSUPPORTED_MODEL`(网关原文透传);只有 401/403 且不属于这三类才叫 `AUTH`。
    因为聊天区把 `AUTH` 渲染成它自己的「API 密钥无效」并**丢掉网关原文**——误判一次就把"该做什么"那句话吞了
    (实测踩过:`deepseek-v4.1-flash` 的 403 region 被说成 key 无效)。`scripts/e2e-active-sub.mjs` 第 7 节钉着。
18. **`projection()` 绝不出值**:生效变量的**名字**、active id、失败原因可以给浏览器,**值不行**。
    它在运行时里只用于跳过重复写入。0.8.3 第一版把它放进了 `/usage` 载荷,等于把当前 key 发给页面——
    改回去就是把这个插件的凭据承诺作废(`tests/subruntime.test.mjs` 断言 `'value' in projection() === false`)。
19. **设置面 = Config schema 里标了 `.volatile()` 的那些字段(0.1.7 起)**:`settings.installSection` 已经
    不存在,宿主给页面的描述符**只带 volatile 字段**,写非 volatile 路径会被直接拒(`Config field "x" is not
    volatile`)。所以**页面读什么、写什么,`src/config.js` 就必须把那些字段标上 `.volatile()`**,漏一个就是
    两种静默故障:读的漏标 = 页面拿不到值、自己填默认值还当真;写的漏标 = 每次保存都被拒。
    `apiKey` 永不 volatile(它是 secret,走 `secrets` 侧面)。`tests/volatile-contract.test.mjs` 两面都钉着
    ("页面读的集合 == volatile 集合" + "页面写的每条路径都 volatile"),加字段/改页面时它会红。
    注册只剩一句 `settings.configure({ auto: false }, ctx.fiber)`(意思:这个条目自带页面,别自动生成);
    **没有 `setSource`**,而且**`apply` 不会因为一次设置写而重跑**(0.2.0 起,见下条):设置写进 profile
    patch,宿主把新值**提交进那条 config 里 volatile 引用本身**(`Entry#_commitVolatile`),对象身份不变,
    所以 `current` 保持 `() => config`,但**读它的那一步必须是活的**(`config.js#createOptionsReader`:
    每次读都重新 resolve,事实没变才复用上一个对象)。
    设置值落在 `$DSH_HOME/profiles/<name>/cordis.patch.yml`,`settings.yaml` 只剩一次性迁移。
     **volatile 字段是引用,不是值**:有了 schema 之后宿主会在 `apply` 之前用它校验配置
     (`runtime.Config['~standard'].validate`),每个 volatile 字段以 cosmokit 引用到达(`.get()` 才是值;
     `String(ref)` 就是 `[object Object]`)。所以**解引用只做一次、就在 `src/config.js#resolveOptions`
     入口**(`plainConfig`;判定用宿主的 `isVolatile`,不靠形状猜——`isVolatile({get(){}})` 是 false)。
    漏了这步 = 启动即 `baseURL must be an absolute http(s) URL (got: [object Object])`,整条条目不激活。
20. **设置写是"就地改引用",不是"重载条目"——所以不许按对象身份做缓存(0.2.0 实测)**:
    `cordis-plugin-loader#Entry.update` 用 `equalExceptVolatile` 判定这次 config 变化**全是** schema-volatile
    字段(页面能写的路径按定义全是,`dsh-settings#write` 会拒非 volatile 路径),成立就走 `_commitVolatile()`:
    把新值写进**运行中那条 config 的引用**、发 `loader/volatile-update`,**不重跑 `apply`**。
    后果:任何 `raw === lastRaw` 式记忆(旧 `options()` 就是)会把加载那一刻的事实**永久**答下去——
    页面显示的订阅宿主根本没听过(没有余额行、没有探针、付款人还是上一条)、
    `models.disabled/extra` 永远不生效(目录 effective 0,「同步/启用模型」全都不落地)。
    `options()` 现在走 `createOptionsReader`(每次重新 resolve + `deepEqual` 比对,事实没变复用旧对象,
    保住 adapter 依赖的身份稳定);它**不依赖**那个事件名,所以宿主再换机制也不会静默失灵。
    `tests/volatile-contract.test.mjs` 用真的 `createVolatile`/`updateVolatile` 钉着"就地写必须被看见",
    外加一条源码守卫(`lastRaw` 不许回来)。
21. **`export default` 里必须带 `Config`**:cordis 的 `unwrapExports` **优先 default**
    (`exports.default ?? exports`),registry 再用它建 runtime(`Config: plugin.Config`),而 settings 从
    runtime 读 schema(`entry.fiber.runtime.Config`;拿不到就 `describe()` 跳过该条目)。default 少 `Config`
    的后果**不是降级而是静默**:插件照常加载、apply、开 HTTP 路由,只有设置页报
    「设置里没有命名空间 opencode-go-native」——0.1.7 起一直如此,因为没有任何测试看过"加载器拿到的那个对象"。
    `tests/loader-contract.test.mjs` 按加载器的规则解包 `lib/` 与 `src/` 两面钉着。

## 上游有两个,互相独立

| 上游 | 决定什么 | 什么时候动 |
|---|---|---|
| 网关 `/models` | **哪些模型存在** | 运行期自动,不用管 |
| models.dev 仓库 | **每个模型的官方声明** | **运行期自动**(新模型现拉 + TTL 重读);打包那份只是离线保底 |

**0.9.0 起运行时抓 models.dev。** 打包的 `data/opencode-go.official.json` 是**发布期快照 = 保底**:
网关上了新模型、而 models.dev 已经有它的 TOML 时,`official-runtime.js` 直接按 `base_model` 规则把
那几个文件拉下来,写进 catalogue 读的那份 document(缓存落 `$DSH_HOME/opencode-go.official-cache.json`)。
所以"今天一个数明天一个数"的担心靠**优先级**解决,不靠不抓:声明永远排在实测(`synced`)和操作者
`models.overrides` **下面**,而且每个数都带来源(诊断面板「官方声明数据」一行 + 日志环)。

- 只有**新 id**(谁都没声明过)是**阻塞**拉取的,并且有 `officialSyncTimeoutMs` 预算;拉不完的进后台补。
- 已知记录的 TTL 重读、以及预算没跑完的部分,都走**后台**(不阻塞页面)。
- 失败一律降级:上游 404 = `absent`(记下来,冷却期内不再问),网络不通 = 打包数据继续服务,
  第一次失败就把整条 base 标记为"不可达"直到冷却结束,免得一个 pass 里付 N 次超时。
- 关掉:`officialSync: false`(只读打包数据),或 `snapshotEnabled: false`(整个声明面关掉,两层一起关)。

## 更新 models.dev 数据

打包那份现在**只在发版时刷**(给连不上 GitHub 的人兜底),但刷的流程没变:

```bash
npm run official:fetch     # 只重拉"上次用到的那些 TOML"
git diff data/opencode-go.official.json
npm run official:check     # CI:不一致就非零退出
```

- 基线里每个模型都记着 `sources`(它是从哪几个文件读出来的),所以刷新**只拉那几个文件**(实测 37 个模型 → 113 个文件),不是 clone 仓库。
- 上游改了某个 TOML → 直接刷新 review,**不用改代码**。
- 网关上了**新模型** → 运行期层自己会拉(这是 0.9.0 的重点),发版时想把它写进保底数据才需要下面这套:
  1. 看它归属哪个 lab(`models/<lab>/<id>.toml`)
  2. provider 目录名和 lab 名不一样 → 往 `src/official-baseline.js` 的 `LAB_PROVIDER_ALIASES` 加一条(现有:`meituan→longcat`、`tencent→tencent-tokenhub`)
  3. 还是找不到 → 用离线冷启动,它能列目录、按 `base_model` 反查:
     ```bash
     git clone --depth 1 -b dev https://github.com/anomalyco/models.dev /tmp/models.dev
     curl -sS -o /tmp/ids.json https://opencode.ai/zen/go/v1/models
     npm run official:fetch -- --repo /tmp/models.dev --input /tmp/ids.json
     ```
     注意 `--repo` 会给**所有** id 重新解析,所以必须对着完整 clone 跑,拿最小目录跑会把别的模型的数字洗掉。
     另外网络模式(`--models` 直接跑)**解析不了全新 id**(它只预热"记录过的路径",实测会产出一条空记录)——
     这正是运行期层要自己按规则预热候选路径的原因。
- **解析不到就记 `unresolved`,绝不拿别的厂商的数字顶上。**

可选:`npm run models:fetch`(刷新 `name`/`npm` 快照)。

## 构建 / 装 / 生效

```bash
npm run build     # src/ -> lib/;也重新生成 lib/client.js
npm test          # 不需要装 profile
npm pack
```

**生效分两半:**

| 改了什么 | 怎么生效 |
|---|---|
| `src/client/**` | 覆盖文件即可,`dsh-client-hmr` 每 500ms stat-poll 自动热重载 |
| `lib/index.js`、`src/*.js`、`data/*.json` | **必须重启 `dsh web`** |

**本地 `link:` 安装需要一层 dev symlink**:pnpm 的 `link:` 只建符号链接、**不装 peer 依赖**,
而 Node 按 workspace 真实路径解析裸包名,`@deepseek-ai/dsh-llm` 等会找不到
(启动报 `ERR_MODULE_NOT_FOUND`,整个 profile boot 失败)。修法是插件目录下一份
**dev-only、已 gitignore 的 `node_modules/`**,把宿主包链到全局 dsh 安装(与宿主同实例):

```bash
DSH_NM=<全局 dsh 安装>/node_modules   # 例:$(dirname "$(readlink -f "$(which dsh)")")/../node_modules
mkdir -p node_modules/@deepseek-ai node_modules/@earendil-works
for p in dsh-llm dsh-timeout dsh-credentials dsh-attachment cosmokit schemastery; do
  ln -sfn "$DSH_NM/@deepseek-ai/$p" "node_modules/@deepseek-ai/$p"
done
ln -sfn "$DSH_NM/@earendil-works/pi-ai" "node_modules/@earendil-works/pi-ai"
```

(`dsh-attachment` 是 0.1.7 起图片链路要的:`readImageRequest` 现在收 `{width,height,maxBytes}` 的
**目标**,尺寸投影由路由自己做,所以直接 import 宿主的 `requestImageDimensions`,不自己写一份。)

注意**动态 `import()` 也要覆盖**:`dsh-credentials` 与 `pi-ai`(含三个 `.lazy` 子路径)
是运行期按需导入的,静态 `from '…'` 扫描抓不到——漏了就是"启动正常、点某个按钮才
ERR_MODULE_NOT_FOUND"。补链后无需重启(动态导入按调用解析)。
`tests/` 不经过这层(它们只 import 无宿主依赖的模块)。

## 发布

```bash
npm run official:check && npm run models:check
npm test
# 改 package.json 的 version
git add -A && git commit -m "release vX.Y.Z" && git push
```

## 推之前扫一遍

```bash
git ls-files | grep -iE '\.env|\.pem|\.tgz' || echo OK
git ls-files -z | xargs -0 grep -InE 'sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}' || echo OK
git ls-files -z | xargs -0 grep -In '/home/[a-z]' || echo OK
```

(`tests/client-logic.test.mjs` 里的 `sk-abcdef…` 是测 `looksLikeSecretValue()` 的夹具,不是真凭据。)

## 常用探针

```bash
npm run probe:sync -- kimi-k3 glm-5 omen-alpha   # 真网关跑同步:可用 / 已下架 / 无官方记录
npm run probe:protocols                          # 协议矩阵
npm run probe:session-headers -- --live          # 会话头实测
npm run probe:quota -- --live                    # 余额端点实录(/usage 三窗口;唯一报告余额的地方)
npm run e2e:multi-sub                            # 离线:假网关验证"只有一个付款人"+ 切换即生效(需 dev symlink 层)
```
