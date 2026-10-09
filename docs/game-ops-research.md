# 游戏 LiveOps 中台设计研究

## 1. 目标与边界

本项目的 LiveOps 中台面向小型游戏团队的本地开发、功能验证和单实例部署。设计目标是把玩家运营、内容发布、商业化、客服、安全与可观测性放进一个权限受控且可审计的控制面，同时保持原有三款游戏、认证、房间与战绩能力不变。

当前 JSON 存储是可运行参考实现，不应被误解为多实例生产数据库。短信、Push、邮件和支付只暴露适配器配置状态；没有供应商回执时，系统不会把任务标记为“已送达”或把退款标记为第三方成功。

## 2. 领域模型

| 领域 | 核心集合 | 关键约束 |
| --- | --- | --- |
| 身份与授权 | `staff` | 角色提供默认权限，员工可附加权限；密码使用 scrypt 哈希 |
| 玩家数据 | `users`、`matches`、`segments` | 画像按玩家聚合，时间线按时间倒序，分群保存规则而非伪造计算结果 |
| 活动 | `campaigns`、`tasks` | 活动与任务分别建模，可通过 `campaignId` 关联并按起止时间形成日历 |
| 触达 | `messages`、`deliveries` | 草稿进入队列后仍记录适配器状态；送达结果只能由真实回执更新 |
| 配置 | `configVersions` | 草稿、已发布、已取代；回滚创建新版本，不篡改历史版本 |
| 实验 | `experiments` | 保存假设、受众、变体、指标和状态；不凭空生成统计显著性 |
| 经济 | `catalog`、`inventoryLedger` | 商品与货币定义可变；账本以追加记录表达资产变化 |
| 订单 | `orders` | 退款要求订单已支付；区分部分退款和全额退款 |
| 竞技 | `seasons`、`leaderboards` | 赛季定义与榜单条目分离，便于冻结与归档 |
| 客服 | `tickets`、`compensations` | 补偿关联工单与玩家，并单独落审计 |
| 内容安全 | `reports` | 举报保留原因、对象、证据引用和审核状态 |
| 风控 | `riskRules`、`riskCases`、`punishments` | 规则命中形成案件，人工或流程审批后再处罚 |
| 健康度 | `healthMetrics`、`alerts` | 指标与告警分离，确认告警不等于问题恢复 |

## 3. RBAC 与最小权限

系统内置五种角色：

- `superadmin`：全权限，只建议用于引导和紧急恢复。
- `operator`：玩家运营、活动、配置、实验、经济、订单、赛季与健康度。
- `support`：玩家只读、触达、订单只读、工单、补偿与举报只读。
- `moderator`：玩家只读、举报、风控案件与处罚。
- `analyst`：经营数据、玩家、实验、经济、订单、榜单、健康度和导出只读。

权限检查位于服务端，前端隐藏按钮不能替代鉴权。写权限自动包含同领域读权限；员工记录可附加细粒度权限。登录令牌携带角色与权限快照，停用员工后应在生产实现中增加令牌版本或服务端会话撤销表，以获得即时失效能力。

这一模型遵循 NIST RBAC 将用户、角色、权限分离的基本思想，并采用最小权限原则。参考：

- NIST RBAC 项目：https://csrc.nist.gov/projects/role-based-access-control
- OWASP Authorization Cheat Sheet：https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html

## 4. 审计与危险操作

管理端每次写入都追加审计记录，字段包括：

```json
{
  "admin": "operator-a",
  "action": "config.publish",
  "target": "config_ab12",
  "detail": "变更摘要",
  "createdAt": "ISO-8601"
}
```

配置发布/回滚、库存调整、订单退款、工单补偿、处罚下发和员工停用属于危险操作。客户端必须通过 `X-Confirm-Action` 发送与动作相同的确认值；缺少确认时服务端返回 HTTP 428 和 `CONFIRMATION_REQUIRED`。这使确认成为服务端契约，而不是仅靠浏览器弹窗。

审计日志不应记录密码、令牌、短信验证码或完整支付凭证。生产系统还应将审计日志写入独立、追加式存储并配置保留策略。参考 OWASP Logging Cheat Sheet：

https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html

## 5. 关键状态机

### 5.1 远程配置

`draft → published → superseded`

发布新版本时，当前已发布版本转为 `superseded`。回滚不会直接把旧记录改回已发布，而是复制旧内容生成一个带 `rollbackOf` 的新发布版本，从而保留完整历史。

### 5.2 消息触达

`draft → queued → accepted/delivered/failed`

本实现只负责前两步。后续状态必须由真实适配器和供应商回执推进。`adapterStatus=unconfigured` 时仍可保存和排队，但不得显示已送达。

### 5.3 订单退款

`paid → partially_refunded → refunded`

仅 `paid` 或 `partially_refunded` 订单可发起退款。当前实现记录内部退款意图和状态；接入支付渠道后，必须以幂等键调用供应商，并根据异步回执更新最终状态，不能以 HTTP 请求成功代替资金成功。

### 5.4 风控处罚

`rule hit → case open → reviewed → punishment active/expired`

规则、案件、处罚拆分可避免“规则命中即封禁”。高风险处罚应进一步引入双人复核、申诉流程和证据保留。

## 6. 导出与隐私

受支持集合可导出为 UTF-8 CSV 或 JSON。CSV 对双引号进行转义，对对象字段序列化为 JSON，响应包含下载文件名。导出仍受 `export.read` 权限控制。

生产环境建议增加：

1. 导出字段白名单与手机号脱敏；
2. 大数据量异步导出和短期签名下载地址；
3. 导出审批、用途说明、水印和下载审计；
4. 数据保留、删除和主体访问请求流程。

## 7. 模块化后端

- `src/server/index.js`：HTTP、认证、玩家 API、原有 Admin API、静态资源和 WebSocket 装配。
- `src/server/liveops.js`：LiveOps 集合初始化、角色权限、资源 CRUD、危险动作、画像聚合与导出。
- `JsonStore.update`：串行化单进程写入并通过临时文件原子替换。

这种拆分保持现有入口兼容，也让未来迁移数据库时可以将 `JsonStore` 替换为仓储层。生产演进顺序建议为：事务数据库 → 队列与作业执行器 → 供应商适配器 → 指标仓库 → 审批流和审计归档。

## 8. 验证策略

自动化测试覆盖：

- 根管理员登录及原有用户、配置、房间接口；
- 员工创建、密码隐藏和员工登录；
- 分析员越权写入返回 403；
- 配置发布缺少确认返回 428，确认后成功；
- 玩家画像聚合；
- CSV 导出内容与响应类型；
- LiveOps 写操作产生审计记录；
- 原有游戏规则、房间、WebSocket 和认证回归。

统一执行：

```bash
npm run check
```

该命令完成 JavaScript 语法检查、全部 Node.js 测试和四个应用构建。

## 9. 业界能力映射

主流平台共同形成“分析、分群、执行、评估、治理”的闭环。PlayFab 允许按条件建立玩家分群，并对分群手动或自动执行任务；Unity Game Overrides 支持按行为、地区和游戏频率选择受众，定时覆盖配置并查看效果；Firebase Remote Config 同时提供分群、灰度、对照组和 A/B 测试能力。[1][2][3]

商业化方面，PlayFab Economy v2 将统一目录、大型库存、高并发、批量操作和幂等交易作为核心能力，因此本项目将商品目录、库存流水和订单状态拆分，并给人工资产调整增加幂等键和余额前后值。[4] 系统治理方面，成熟平台应同时提供指标、日志、仪表盘和告警；本项目将健康指标与告警记录分开，便于后续连接真实可观测平台。[5]

| 能力域 | 本项目实现 |
| --- | --- |
| 玩家与分群 | 玩家 360 画像、事件时间线、规则分群、名单检索 |
| 数据分析 | 核心指标、14 天趋势、转化漏斗、D1/D7/D30 留存、注册周 Cohort、游戏分布 |
| 活动与任务 | 活动日历、任务关联、周期和状态管理 |
| 触达 | 公告、站内信、Push/短信/邮件适配器状态和发送队列 |
| 配置与实验 | 配置版本、发布、回滚、游戏开关、A/B 实验定义 |
| 经济与订单 | 商品目录、资产账本、余额前后值、幂等调整、订单和退款意图 |
| 竞技 | 赛季和排行榜记录 |
| 客服 | 工单、补偿及资产入账 |
| 安全治理 | 举报、风控规则、风险案件、处罚和账号禁用 |
| 系统治理 | RBAC、审计、健康指标、告警确认、CSV/JSON 导出 |

这里的“实现”指可运行的单实例产品基线。真实 Push、短信、邮件、支付退款、内容机审和实名服务仍需配置供应商适配器；大规模生产环境需要把 JSON 存储迁移到事务数据库，并将分析事件写入数仓。

## Sources

1. Microsoft PlayFab, Player segments: https://learn.microsoft.com/en-us/xbox/playfab/player-progression/player-data/player-segments
2. Unity Gaming Services, Game Overrides: https://docs.unity.com/ugs/en-us/manual/game-overrides/manual/overview
3. Firebase, Remote Config: https://firebase.google.com/docs/remote-config
4. Microsoft PlayFab, Economy v2 overview: https://learn.microsoft.com/en-us/gaming/playfab/features/economy-v2/overview
5. Amazon Web Services, What is Amazon CloudWatch: https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/WhatIsCloudWatch.html
