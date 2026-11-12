# DSH QQBot Suite

> 为官方 QQ 机器人插件（`@tencent-connect/dsh-qqbot`）提供增强能力的套件。

- 前置插件： `@tencent-connect/dsh-qqbot` 

- 环境要求：DeepSeek Harness >= 0.2.2-rc.1，Node.js >= 22

- 开发环境

    | 组件 | 版本 |
    |---|---|
    | DeepSeek Harness（dsh） | 0.2.2-rc.1 |
    | @tencent-connect/dsh-qqbot | 0.5.5 |
    | Node.js | 22 |


## 安装

### 前置步骤

安装 DeepSeek Harness 与官方 QQ 机器人插件（`@tencent-connect/dsh-qqbot`）。

### 从 GitHub 安装：

在 DSH 插件页面，点击添加插件，将项目地址 https://github.com/wu1yi2fan/dsh-qqbot-suite 填入，点击安装。

也可以在终端里用命令安装：

```bash
dsh plugin --profile web add github:wu1yi2fan/dsh-qqbot-suite
```

安装后重启 dsh，在「设置 → QQ 机器人套件」里配置即可。

## 插件说明

| 子插件 | 作用 |
|---|---|
| `qqbot-suite` | 套件本体：运行期配置、`/api/qqbot-suite/*` 路由、设置页 |
| `qqbot-suite-gate` | 群聊消息闸门：关键词 / 语义判断 / 全部放行 |
| `qqbot-suite-guard` | 命中工作区的 agent 禁用指定全局工具；群聊工具白名单可在设置页配置 |
| `qqbot-suite-self` | `qqbot_bot_profile` 工具：查机器人名字、id、分享链接、头像链接（**默认停用**，在插件页面启用） |

提供包括但不限于以下功能：

- **群聊消息闸门**：控制哪些消息会传给dsh进行回复。包括 @ / 引用 / 唤醒词 三种模式，都没命中时可以选择用调用模型做一次语义判断（「这句是不是在跟它说」），也可以全部放行；
- **群聊上下文增强**：收到消息时自动带上最近的对话，解决官方「群聊只在被 @ 时带前文、答完就清空」的限制；
- **媒体缓存上限**：给官方插件的图片缓存目录添加存储数量上限；
- **斜杠命令白名单**：控制谁可以使用 `/new` 等命令，其他人的消息先去掉行首的 `/`；
- **处理超时自动中断**：回复时运行时间过长自动中断，避免坏人让bot干背圆周率之类无限消耗token的事情；
- **回复消息类型可选**：markdown（`msg_type=2`）在旧版 PC QQ 上只显示「暂不支持该消息类型」，这里可以选「自动 / 一律纯文本 / 一律 markdown」。自动档只在正文含代码块、表格、多条列表等明确结构时才用 markdown，其余发纯文本——判错方向的代价不对称，宁可少排版也别让消息直接看不见；

## 运行机制与注意事项

### qqbot-suite

套件本体的以下功能会读取或修改官方插件的配置、文件及运行状态：

* 媒体缓存数量限制：根据设置的数量上限，定期删除官方缓存目录 ~/.dsh-qqbot/media 中最旧的文件。
* Bot 工作区设置：修改官方插件配置文件 cordis.patch.yml，将 im-qqbot.cwd 设置为指定的工作区路径。
* 机器人资料与群状态查询：使用运行中的机器人实例调用官方接口。

### qqbot-suite-gate

群聊闸门插件在启动及执行语义判断时，需要定位官方插件的安装目录并读取宿主模块：

* 宿主模块定位：插件优先向 dsh 的 loader 查询当前加载的 profile 目录和官方插件状态（是否配置/禁用）；loader 缺席时按目录约定查找。主位置找不到时，会在同一 DSH_HOME 下的其他 profile 里扫描
* 宿主模块补丁：定位 qqbot-nodejs 与 dsh-qqbot 的入口文件。动态导入后，对 QQBot 和 SessionManager 进行 Patch，以获取机器人实例引用及会话句柄。

### qqbot-suite-guard

工具闸门在判断会话是否属于群聊时，会解析会话路径，并将会话关联到对应的工作区。解析成功后，dsh 会自动将该会话归入指定工作区。

### qqbot-suite-self

查询机器人资料时会读取官方插件保存的凭据：

* 机器人在线时：直接使用运行中的机器人实例所持有的凭据。
* 机器人离线时：尝试从以下位置读取凭据，并使用这些凭据调用官方接口查询相关信息：
    * 环境变量 QQBOT_APPID / QQBOT_SECRET
    * cordis.patch.yml 中 im-qqbot 配置段的 appId / appSecret


## 开发说明

本插件由Deepseek Harness进行开发调试，由 Codex 与 Workbuddy 协助开发。

## 特别感谢

陆氏弗莱格重症看护室的群友们

## License

[MIT](./LICENSE)
