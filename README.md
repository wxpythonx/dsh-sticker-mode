# dsh-sticker-mode — 「表情包模式」开关

DSH Web GUI 输入框右侧的一个开关（位置与样式对齐 jev 的绿色开关）。**打开后，AI 每次回复末尾会自动附一张与对话内容相关的表情包。**

- 状态真相在 Host：`~/.dsh/sticker-mode.json`（`{"enabled":true|false,...}`），Agent 直接读得到。
- 图片走 DSH 自己的 Web 服务（同源 `:3080/sticker-mode/img/...`），不占第二个端口、不依赖防火墙。
- 图片地址前缀由**浏览器上报 `location.origin`** 决定，所以多网卡/局域网访问都不会拼错地址。

---

## 为什么需要这么个插件（三条实测硬约束）

1. **模型发不出图片。** 生产适配器声明 text-only 输出，assistant 消息里塞 `image` 块是前向兼容而非可用能力。所以图只能靠 Markdown 图片链接。
2. **上游防盗链。** `img.soutula.com` 强制校验 `Referer: https://fabiaoqing.com/`，而 DSH 渲染 Markdown 图片时写死 `referrerPolicy="no-referrer"` —— 浏览器直连必然 403。故字节必须由 Host 侧代理。
3. **客户端未必在本机。** DSH 的 Web 服务默认监听 `0.0.0.0`，浏览器可能在另一台设备上。这时 URL 里写 `127.0.0.1` 会指向**浏览器自己**的 loopback，图全破。而"服务端自己猜网卡"也不可靠：多网卡机器上取到的第一张网卡未必是客户端使用的那张（本项目实测就取错过）。唯一可靠的信息源是**浏览器自己的 `location.origin`**。

## 三个机制

| 机制 | 用的 API | 说明 |
|---|---|---|
| **Agent 感知开关** | `ctx.systemPrompt.section({text: (context) => ...})` | `text` 传函数时**每次 model assembly 都重新求值**，所以开关一翻下个 step 就生效，且**不增加任何 step**。（不存在"把状态写进工具 description"的机制：`dsh-tools` 的 `schemas()` 只白名单 name/description/parameters。） |
| **同源供图** | `ctx.webServer.register({kind:'prefix'|'exact', path, handler})` | 自定义路由**不落在 `/api` 前缀下 → 完全不过鉴权中间件**，匿名可取图，`<img src>` 直接用。 |
| **选图** | `ctx.tools.register(defineTool({...}))` | `sticker_pick` 搜图返回一行 Markdown；`sticker_mode` 读写开关。 |

### 图片地址前缀按**会话**记（重要）

`/sticker-mode/client` 上报的不是一个全局值，而是 **sessionId → origin** 的映射：

- 只存一个全局值会踩坑：谁最后上报就算谁。实测出现过——某台**在宿主机本机打开的浏览器**
  上报了 `http://127.0.0.1:3080`，于是工具把 `127.0.0.1` 烙进了消息文本；
  之后在局域网设备上看这条消息，`127.0.0.1` 指的是**那台设备自己**，图全破。
  多网卡主机上，不同网段的客户端之间也会互相拿到对侧不可达的地址。
- 所以 `sticker_pick` 会用**调用方会话**的 origin（`exec.agent.sessionId`，多重兜底取），
  取不到才回落到"最近一次上报值"，再回落到兜底地址（默认 `http://127.0.0.1:<port>`，
  可用 `DSH_STICKER_MODE_ORIGIN` 固定）。

**但消息一旦提交就改不动**了 —— 地址是生成那一刻写进消息文本的。所以浏览器半边额外做一件事：
渲染时把 `/sticker-mode/` 图片的**主机前缀就地改写成本浏览器的 origin**
（只改前缀，路径原样保留，`MutationObserver` 兜住新出现的消息）。
这样即使历史消息里烙的是别的网段/`127.0.0.1`，在当前设备上也能正常显示。

## 安装与生效

```powershell
# 1) 装进 profile（幂等：复制 + junction + patch 行 + 依赖项）
pwsh -File .\install.ps1
#    自定义 profile 位置： pwsh -File .\install.ps1 -ProfileDir 'D:\tmp\dsh\profiles\web'

# 2) 重启 dsh web
# 3) 强刷浏览器页面（Ctrl+F5）
```

> **⚠️ 必须重启，不能热生效。** 实测两条路都不行：
> - 往 profile 的 `cordis.patch.yml` 新增 insert 行**不会热生效**（挂了十几分钟都是 404）；
> - 市场（dshmarket）的 `/dsh-market/toggle` 确实能 `hotMount` 一个**新装**的插件，但它 import 的是**已经被缓存的模块**——Node 的 ESM 缓存按解析后的真实路径做键，进程内无法失效。所以**改了 Host 侧代码后，热挂载拿到的是旧代码**。
>
> 冷启动才是这个 profile 体系的正常重载方式（bundle 行同样只在启动时组合）。

**安装后各文件的位置**

| 路径 | 作用 |
|---|---|
| 本仓库 | 源码（唯一真相） |
| `<ProfileDir>/plugins/dsh-sticker-mode/` | 安装副本（installer 复制过来） |
| `<ProfileDir>/node_modules/dsh-sticker-mode` | 指向上面的 junction，让 loader 能解析 |
| `<ProfileDir>/cordis.patch.yml` | 末尾 `- insert: [{id: ui-sticker-mode, name: 'dsh-sticker-mode'}]` |
| `<ProfileDir>/package.json` | `dependencies` 加 `"dsh-sticker-mode": "file:./plugins/dsh-sticker-mode"` |

（`<ProfileDir>` 默认 `~/.dsh/profiles/web`。）

**注意**：`ui-sticker-mode` 这个 loader 行 id 只能有一个来源。**要么** patch insert（本插件走的路），**要么** `dsh.profile.bundles` 注册——两者同时做会 `duplicate loader entry id` 崩 loader。installer 检测到这种情况会直接报错退出。

**环境变量**

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_STICKER_MODE_PORT` | `3080` | 兜底地址用的端口 |
| `DSH_STICKER_MODE_ORIGIN` | 空 | 固定图片地址前缀（只在没有任何客户端上报时生效），如 `http://192.168.1.10:3080` |
| `DSH_STICKER_MODE_PATH` | `~/.dsh/sticker-mode.json` | 开关状态文件位置 |

开关状态也可以直接改文件（插件每次判定都现读，不缓存）：

```powershell
'{"enabled":true}' | Set-Content "$env:USERPROFILE\.dsh\sticker-mode.json"
```

## HTTP 端点

| 路由 | 说明 |
|---|---|
| `GET /sticker-mode/state` | 读开关状态 + 当前图片地址前缀 + origin 来源（排障用） |
| `POST /sticker-mode/state` | `{enabled:boolean}` 写开关（**带同源校验**，防 CSRF） |
| `POST /sticker-mode/client` | 浏览器上报 `location.origin`（同样要求同源） |
| `GET /sticker-mode/img/<dir>/<file>` | 图片字节代理（匿名可取的 prefix 路由） |

`<dir>` 白名单：`large`/`bmiddle`/`thumb`/`small`/`mw600`/`mw690`；扩展名限 `gif|jpg|jpeg|png|webp`。

## 控制台 API（排障）

```js
__dshStickerMode.state()   // 读 Host 状态
__dshStickerMode.on()      // 打开
__dshStickerMode.off()     // 关闭
__dshStickerMode.probe()   // 用当前 origin 实际加载一张图，验证地址前缀对不对
```

---

## 事故复盘（2026-10-09，务必先读）

那次把插件系统搞崩了（Web GUI 打不开会话），根因**是工具 schema 写错**，外加我对"热加载"的错误假设。

### 踩坑 1：`parameters` 里不能写 `required: false`

```
unsupported JSON schema: parameters.index.required must be true when present
```

作者 DSL 的规则是：**必需性写在叶子上**，`required: true` 表示必填；
**可选参数要整个省略 `required` 字段**——写 `required: false` 是非法的。

### 踩坑 2：`output.schema` 也是作者 DSL，不能写顶层 `required: ['text']`

```
unsupported JSON schema: schema.required is not supported by the value schema DSL
```

正确写法是叶子级：`properties: { text: { type: 'string', required: true } }`。
DSL 会自己把它提升成 `required: ["text"]`（验证时打印出的编译结果可见）。

> 这个错**更阴**：它被 `safely` 兜住后不报错、不崩，表现为"**插件加载了、路由通了、但工具凭空消失**"。
> 所以排查"工具怎么没有了"要去看 `ctx.logger.warn` 的 `[sticker-mode] xxx failed:`。

### 踩坑 3：非法 schema 会让**整棵组合树**崩，不只是插件自己

`defineTool` 在**定义时同步**编译 schema（`dsh-tools/lib/index.js:840` → `parameterSchemaSpecToJsonSchema`），
而 `defineTool` 是在 `apply()` 里调用的。于是：

```
apply() 抛异常 → loader 应用该 entry 失败 → 整个 patch 层重新组合失败 → 会话全打不开
```

**所以 `apply()` 里每一项注册都必须单独 try/catch 兜底**（本插件的 `safely()`）。
一个插件绝不该有能力拖垮整个 host。

### 踩坑 4：改了 Host 侧代码，进程内无法重载（ESM 缓存）

市场日志里两次 `hot-mount` 都失败在**同一个已被修掉的错**上——因为第一次尝试就 import 并缓存了模块。
**结论：改 Host 侧代码只能重启。** 也不要试图"换物理目录名绕过缓存"再用市场热挂载：
旧实例还挂在进程里卸不掉，换目录再挂只会得到**第二个实例**（重复注册同一路由必然抛错），
结果就是"路由来自旧实例、工具来自新实例"的半吊子状态；而且在运行中的 Host 上做
junction 手术，一旦被中断就可能留下悬空 junction 让整棵树起不来（本项目真的因此崩过一次）。

### 排查这类问题的工具

不必靠猜：本仓库的做法是**用假 ctx 在独立进程里跑一遍 `apply()`**，
把注册到的路由/工具/schema 全打出来。它能抓到"注册被静默降级"这类在运行时看不见的问题：

```js
const ctx = { effect(fn){...}, tools:{register(t){got.push(t)}}, webServer:{register(r){...}},
              systemPrompt:{section(s){...}}, logger:{warn(m){got.warnings.push(m)}} };
(await import('file:///.../dsh-sticker-mode/lib/index.js')).apply(ctx);
```

注意：必须以 **profile 目录**为解析基准（工作区副本解析不到 `@deepseek-ai/dsh-tools`，
它要从 `~/.dsh/profiles/node_modules` 往上找）。

---

## 内置图库（本地优先）

线上搜索只能按**标题**判断内容，而上游标题经常与画面不符、甚至藏荤梗
（实测搜「完美」返回的第一张就是荤梗）。所以内置了一份**逐张过目筛选过**的图库：

```
library/
  index.json        索引：{ version, source, tags: { "鼓掌": [ {slug, file, title, desc, animated} ] } }
  _audit-*.jpg      审核图（分条，编号对应索引顺序，用于核对图库里到底是什么）
  _staging/         抓取暂存 + 每个标签的对比图（**不装进 profile**，installer 会剔除）
  guzhang/1.gif …   图片本体，按 ASCII slug 分目录
```

`sticker_pick` 的行为：**先查内置图库**（标签精确命中 > 标签包含 > 标题包含 > 描述包含），
命中就直接返回本地图片；没命中再回落线上搜索。可用 `source` 参数强制：
`auto`（默认）/ `library`（只用图库）/ `web`（只用线上）。

### 策展流程（两个脚本）

```powershell
node tools/curate.mjs          # 按标签抓候选 + 拼"带序号的对比图"（一标签一屏）
#  → 用 read_image 逐屏过目对比图，决定留哪几张、写标题与描述
node tools/build-library.mjs   # 按 CHOICES 固化图库 + 生成审核图 + 跑自检
```

要点：
- **对比图是为了省上下文**：一屏能横向比较同标签的 5 个候选，还能一眼看出内容是否得体。
- **`read_image` 是策展的关键能力**：插件**运行时**看不到图（只能按标题挑），
  但**离线过目时能真的看图**——这也是这份图库比线上搜索干净得多的原因。
- 被否掉的典型：尴尬 #2（低俗）、厉害 #0/#2/#3/#4（是"万能回复表格"不是表情包）、
  收到 #2（转账营销）、加油 #0（"男神加油"语境太窄）。

### 三个踩过的坑

1. **候选文件号有断档**：抓取阶段上游限流会让部分候选下载失败（例如「谢谢」只剩 `c0` 和 `c4`），
   而对比图上的标签是**排列序号**、不是文件号 —— 两者在断档时不相等，
   一开始因此选错了两个标签。所以 CHOICES 一律用文件号，最后再用审核图逐格核对。
2. **URL 里别放中文**：中文标签进 URL 要百分号编码（`%E6%91%B8%E9%B1%BC`），
   而 DSH 的 Markdown 净化器是压缩过的、无法确认它会不会把 `%` 再编码一次（→ 404 破图）。
   改用 ASCII slug（`guzhang/1.gif`）把这个不确定性彻底消掉；**中文标签仍是检索键**。
3. **`rmSync(dir, {force:true})` 会静默不删**（Windows 上删目录失败也不报错）——
   今天因为它两次留下脏文件。现在 `build-library.mjs` 末尾有**构建后断言**：
   磁盘目录必须与索引严格一一对应，否则 exit 1。

### 只按索引白名单服务文件

`/sticker-mode/lib/<slug>/<file>` 只服务**索引里存在的条目**（先白名单查，再读磁盘）。
既限定了可服务范围，也顺带杜绝了目录穿越——不存在的路径连白名单都进不去。

---

## 已知边界

- 图片是**实时转发**，不进 DSH 附件库、不参与会话日志的附件记录、也不作为图像喂给模型。**AI 看不到图**，只能按标题文字挑，所以关键词越贴合语境越准。
- 服务/Host 停掉后，历史消息里的图片链接会变成破图（Markdown 文本仍在）。
- 上游偶发限流，已做 3 次退避重试 + 超时（没有超时会把请求永久吊住，实测踩到过）。
- 缓存是 **64 MiB 字节上限的 LRU**（GIF 单张可达数百 KB～数 MB，只数字条会吃爆内存）。
- 依赖 `~/.dsh/sticker-mode.json` 作为开关真相；文件损坏/缺失一律按**关闭**处理（这个开关只是加表情，不是护栏）。

## 卸载

```powershell
# 1) 从 profile 的 cordis.patch.yml 删掉 ui-sticker-mode 区块（含市场追加的 disabled:false 行）
# 2) 删 junction 与插件目录
Remove-Item "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-sticker-mode" -Recurse -Force
Remove-Item "$env:USERPROFILE\.dsh\profiles\web\plugins\dsh-sticker-mode" -Recurse -Force
# 3) 从 package.json 的 dependencies 删掉那行
# 4) 重启 dsh web
```
