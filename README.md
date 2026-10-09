# 弈境游戏套件与 LiveOps 中台

三个独立发布、共享认证、持久化和实时房间能力的网页游戏，以及一套可独立运行的响应式 LiveOps 中台。项目使用 Node.js 20+、原生 Web API 与 WebSocket，不依赖前端框架。

## 启动

```bash
npm run build
npm run start:gobang
# 或 npm run start:doudizhu
# 或 npm run start:mahjong

# 独立运营后台（默认 3100 端口）
ADMIN_USERNAME=operator ADMIN_PASSWORD='请替换为强密码' ADMIN_JWT_SECRET='独立随机密钥' npm run start:admin
```

默认访问 `http://localhost:3000`。可通过 `PORT` 更换端口。

首次使用先注册或登录。进入牌桌后可创建六位房间号，或通过 `?room=ABC234` 邀请链接加入。未登录连接无法升级到 WebSocket，断线后会在五分钟席位窗口内自动凭本地房间令牌恢复。

## 独立构建产物

`npm run build` 生成：

- `dist/apps/gobang`：五子棋独立静态应用
- `dist/apps/doudizhu`：斗地主独立静态应用
- `dist/apps/mahjong`：麻将独立静态应用
- `dist/apps/admin`：运营管理平台独立静态应用
- `dist/server`：共享 Node.js 服务端

部署时为每个应用设置对应的 `APP` 环境变量，并复用同一服务端产物。三套前端均包含自己的入口文件与共享代码副本，可独立打包、上传和回滚。

也可分别执行 `npm run build:gobang`、`npm run build:doudizhu`、`npm run build:mahjong` 或 `npm run build:admin`。

## 配置

| 环境变量 | 用途 | 默认值 |
| --- | --- | --- |
| `APP` | `gobang`、`doudizhu` 或 `mahjong` | `gobang` |
| `PORT` | HTTP 端口 | `3000` |
| `JWT_SECRET` | JWT HMAC 密钥；生产环境必须设置 | 仅开发默认值 |
| `DATA_FILE` | JSON 数据文件位置 | `data/store.json` |
| `PUBLIC_ORIGIN` | 微信回调与请求基准地址 | 本地地址 |
| `WECHAT_WEB_APP_ID` | 微信开放平台网站应用 AppID | 空 |
| `WECHAT_WEB_SECRET` | 微信开放平台网站应用 Secret | 空 |
| `WECHAT_MINI_APP_ID` | 微信小程序 AppID | 空 |
| `WECHAT_MINI_SECRET` | 微信小程序 Secret | 空 |
| `ADMIN_USERNAME` | 独立管理员账号 | `admin` |
| `ADMIN_PASSWORD` | 独立管理员密码；生产环境必须设置 | 空 |
| `ADMIN_JWT_SECRET` | 管理会话签名密钥；生产环境必须独立设置 | 回退到 `JWT_SECRET` |

生产环境必须设置 `NODE_ENV=production`、高强度 `JWT_SECRET`、`ADMIN_PASSWORD` 和独立的 `ADMIN_JWT_SECRET`，并使用 HTTPS。管理会话使用独立的 8 小时 JWT 与 `HttpOnly; SameSite=Strict; Secure` Cookie，登录接口按来源 IP 限流。默认短信适配器只面向开发：验证码输出到服务端日志，非生产响应也会返回验证码。接入真实短信供应商时替换 `smsAdapter.send`，不要在响应中暴露验证码。

## 运营平台

执行 `npm run start:admin` 后访问 `http://localhost:3100`。根管理员来自环境变量；根管理员可创建员工账号，员工随后使用自己的账号登录。

- **员工与 RBAC**：`superadmin`、`operator`、`support`、`moderator`、`analyst` 五类角色，服务端逐接口鉴权，支持员工附加权限与停用。
- **玩家运营**：搜索与禁用、360° 画像、比赛/资产/订单/工单/举报时间线、规则分群。
- **内容运营**：活动和任务日历、站内信/Push/邮件触达任务、第三方适配器状态。
- **发布与实验**：远程配置版本、发布和回滚，A/B 实验及假设记录。
- **经济系统**：货币/商品目录、库存不可变账本、订单状态和全额/部分退款。
- **竞技与服务**：排行榜赛季、榜单记录、客服工单与补偿、举报审核。
- **安全与可观测性**：风控规则/案件/处罚、健康指标/告警、在线房间和不可变更式审计记录。
- **数据流转**：受权限保护的 CSV/JSON 导出；可从列表页直接导出。

游戏进程与 Admin 进程需指向同一个 `DATA_FILE`。禁用状态会在玩家登录、HTTP 会话请求及每次 WebSocket 操作时重新校验；关闭游戏后新连接与已有房间后续操作都会被拒绝。多进程生产部署建议将 JSON 存储替换为具备事务和并发写能力的数据库。

### 安全语义

- 管理端 Cookie 为 `HttpOnly; SameSite=Strict`，生产环境追加 `Secure`；管理 JWT 与玩家 JWT 可使用独立密钥。
- 每个管理端写接口都写入 `auditLogs`，包含操作者、动作、对象、摘要和时间。
- 配置发布/回滚、库存调整、退款、补偿、处罚和员工停用要求 `X-Confirm-Action` 请求头（或同值 `confirm` 字段），缺失时返回 `428 CONFIRMATION_REQUIRED`。
- 短信、Push、邮件、支付仅保存适配器状态；未配置时保持 `unconfigured`，消息只进入 `queued`，不会伪造送达或退款成功。
- JSON 存储适合单实例演示和验收。生产环境应换用事务数据库、集中式审计存储、密钥管理服务及队列。

### LiveOps API

所有路径均位于 `/api/admin/liveops`，并要求有效员工会话：

| 领域 | 资源或动作 |
| --- | --- |
| 总览 | `GET /bootstrap` |
| 玩家 | `GET /players/:id`、`segments` |
| 活动触达 | `campaigns`、`tasks`、`messages`、`deliveries` |
| 配置实验 | `configVersions`、`configVersions/:id/publish`、`configVersions/:id/rollback`、`experiments` |
| 经济订单 | `catalog`、`inventoryLedger`、`orders`、`orders/:id/refund` |
| 排行客服 | `seasons`、`leaderboards`、`tickets`、`tickets/:id/compensate` |
| 安全健康 | `reports`、`riskRules`、`riskCases`、`punishments`、`healthMetrics`、`alerts` |
| 导出 | `GET /export/:resource?format=csv|json` |

集合资源支持 `GET`、`POST`、`PATCH /:id`；列表支持 `q` 与 `status` 过滤。详细边界、状态机与演进建议见 [`docs/game-ops-research.md`](docs/game-ops-research.md)。

## 已实现能力

- 手机验证码注册、手机号密码登录、手机号验证码登录、退出登录
- HMAC-SHA256 JWT、HttpOnly/SameSite Cookie 会话
- scrypt 密码哈希、请求体大小限制、认证与短信双层限流
- 原子替换式 JSON 持久化
- 微信网站应用扫码登录、回调换取身份、签名 `state` 防伪与自动建立会话
- 微信小程序 `code2Session` 登录适配器；网页与小程序凭证独立配置
- 个人资料、最近 50 条战绩
- 登录保护的六位房间号、邀请链接、观战、心跳和断线重连
- 每个连接仅接收自己的私有手牌，所有操作由服务端权威校验
- 对局结束自动为每位登录玩家持久化胜、负或和局战绩
- 五子棋：15×15 棋盘、胜负判定、认输、求和、双方确认悔棋、连续对局
- 斗地主：完整发牌、叫分、三人加倍、常用牌型、出牌提示、托管、炸弹/火箭、春天/反春和零和积分
- 麻将：136 张无花牌、摸打、弃牌提示、吃碰杠、补杠、抢杠和、自摸、点炮、一炮多响、七对和十三幺
- 手机、平板、桌面响应式布局
- 三款应用均提供独立 `manifest.webmanifest`，支持作为独立 Web App 安装

## 验证

```bash
npm run check
```

该命令依次执行服务端与前端语法检查、全部 Node.js 规则/房间/认证/LiveOps/RBAC/危险操作/导出集成测试，以及四个独立应用的全量构建。

## 实时架构

`src/realtime-server.js` 负责 WebSocket 协议、心跳和连接生命周期；`src/room-manager.js` 负责房间、席位、观战、隐私快照、重连与结算回调；`src/games/` 保存三套纯规则状态机。认证用户身份由 HTTP Upgrade 请求中的 HttpOnly 会话 Cookie 建立，客户端不能自行声明用户。

房间运行状态保存在单个 Node.js 进程内，服务重启后清空；用户、资料和战绩通过 `DATA_FILE` 指向的 JSON 文件原子持久化。横向扩容时应将房间状态与广播迁移至 Redis。
