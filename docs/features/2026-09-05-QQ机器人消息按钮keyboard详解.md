# QQ 官方机器人消息按钮（keyboard）详解

日期：2026-09-05
信息来源：QQ 开放平台官方文档站 bot.q.qq.com/wiki（2026-07 ~ 2026-09 更新的新版 OpenAPI 文档）。
适用范围：新版 q.qq.com 机器人的**群聊（GROUP_AT_MESSAGE_CREATE）与单聊（C2C_MESSAGE_CREATE）**接口（`POST /v2/groups/{group_openid}/messages` / `POST /v2/users/{user_openid}/messages`）。旧版频道（guild）接口是另一套，本文不覆盖（仅个别字段标注频道差异）。
文中标注【文档未说明】的地方是官方文档缺失的信息，不要凭猜测实现，需实测。

## 1. 按钮是什么

官方术语：**内嵌键盘（keyboard / INLINE_KEYBOARD）**，文档章节名"消息按钮"。官方原话："在 markdown 消息的基础上，支持消息最底部挂载按钮"。

- 用户视角：QQ 客户端里一条 Markdown 消息（msg_type=2）的底部多出一条按钮区，可横排多行，按钮可点击。
- 按钮是 **Markdown 消息的配套能力**：发送时 `msg_type=2` + `markdown.content` + `keyboard` 字段一起发。
- 注意：Markdown 的 `template_id` / `custom_template_id` 机制**已废弃**，现在直接传 `markdown.content` 自定义文本即可，无需申请 markdown 模板。

交互总流程（官方"消息交互概述"）：

1. bot 下发带 `keyboard` 的消息 → 用户端看到按钮；
2. 用户点击按钮 →
   - 回调按钮（type=1）：平台向 bot 推送 `INTERACTION_CREATE` 事件；
   - 指令按钮（type=2）：以**用户身份**自动发出一条普通消息，bot 收到的是普通消息事件；
3. bot 处理（回调按钮需在 3 秒内调 `PUT /interactions/{interaction_id}` 回应）。

## 2. 发送：keyboard 字段的两种形式

`keyboard` 字段两种形式**互斥**，二选一：

```jsonc
// 短形式（模板）：模板在开放平台管理后台申请并过审后获得 ID
// 官方注明：按钮模板暂不支持变量填充（模板内容写死）；标注【申请使用】
"keyboard": { "id": "1070001" }

// 长形式（自定义）：完全自定义布局，标注【内邀开通】（社区实践中不少 bot
// 能直接用，是否可用需实测；报错则是未开通）
"keyboard": {
  "content": {
    "rows": [
      { "buttons": [ /* Button, Button, ... */ ] },
      { "buttons": [ /* ... */ ] }
    ]
  }
}
```

规模限制：**最多 5 行 × 每行 5 个按钮**（超限错误码 40034029）。

## 3. Button 结构

```jsonc
{
  "id": "btn1",                          // 按钮 ID，同一 keyboard 内唯一
  "render_data": {
    "label": "点击查询",                  // 按钮文字，最多 10 字符
    "visited_label": "已点击",            // 点击后显示的文字
    "style": 1                           // 0 灰线框 / 1 蓝线框 / 3 白底红字 / 4 蓝底白字
  },
  "action": {
    "type": 2,                           // 动作类型，见 §4
    "permission": { "type": 2 },         // 谁可操作，见 §5
    "data": "/help",                     // 动作数据（指令/回调/链接），随 type 语义变化
    "enter": true,                       // 仅 type=2 且仅单聊：点击后直接自动发送
    "reply": true,                       // 仅 type=2：自动发送时带引用回复原消息
    "anchor": 1,                         // 仅 type=2 且仅单聊（手机端 8983+）：唤起选图器
    "unsupport_tips": "客户端不支持"       // 客户端不支持该 action 时弹出的 toast
  },
  "group_id": "grp1"                     // 分组 ID：同组内一个按钮被操作后其它变灰
                                         // （仅 action.type=1 有效，见 §4.2）
}
```

## 4. action.type：三种动作

### 4.1 type=0 跳转按钮

`data` 填 http(s) 链接或小程序 scheme，点击后客户端跳转。适合"打开管理页""查看详情"类需求。对 bot 侧零事件负担。

### 4.2 type=1 回调按钮

- 点击后平台向 bot 推送 `INTERACTION_CREATE` 事件，`data` 字段原样到达后台；
- 需订阅 **INTERACTION 意图（1<<26）**（WebSocket 或 Webhook 接收）；
- 事件关键字段：`type=11`（消息按钮回调）、`scene`（c2c/group/guild）、`chat_type`（1=群 2=单聊）、`group_openid`/`user_openid`、`data.resolved.button_data` 与 `button_id`——即发送时填的 `action.data` 与按钮 `id`，靠它做业务分发；
- **必须回应**：调 `PUT /interactions/{interaction_id}`，请求体 `{"code": 0}`（0 成功 / 1 失败 / 2 频繁 / 3 重复 / 4 无权限 / 5 仅管理员）。不回应则客户端按钮一直 loading 直到超时；**响应超时仅 3 秒**；同一 interaction_id 只能回应一次；
- 若要点按钮后再发一条消息：发消息接口的 `event_id` 字段支持传 INTERACTION_CREATE 事件的外层 id 做**被动回复**（与 `msg_id` 二选一）；
- 按钮分组联动置灰：Button 的 `group_id` 相同时，组内一个按钮被操作后其余变灰不可点（投票/抢答类场景用）。

### 4.3 type=2 指令按钮

- 点击后自动在输入框插入 `@bot data`；配 `enter=true`（**仅单聊**）点击直接自动发送；
- 自动发送后，bot 收到的是**普通消息事件**（GROUP_AT_MESSAGE_CREATE / C2C_MESSAGE_CREATE），不是 INTERACTION_CREATE——不需要订阅新意图，bot 现有的命令分发逻辑原样复用；
- `reply=true` 自动发送时引用回复原消息；`anchor=1` 唤起手机 QQ 选图器（仅手机端单聊）。

## 5. action.permission：谁有资格点

`permission` 是 action 里的**子对象**，控制该按钮允许谁操作：

```jsonc
"permission": {
  "type": 0,                             // 见下表
  "specify_user_ids": ["uid1", "uid2"], // type=0 时列有权限的用户
  "specify_role_ids": ["r1"]             // type=3 时列身份组（仅频道）
}
```

| type | 含义 | 备注 |
|---|---|---|
| 0 | 指定用户可操作 | 配套 `specify_user_ids`（频道的 type=3 另配 `specify_role_ids`） |
| 1 | 仅管理员可操作 | "管理员"如何判定（群管理员/群主/机器人管理员）**【文档未说明】**，需实测 |
| 2 | 所有人可操作 | 群聊默认选这个 |
| 3 | 指定身份组可操作 | **仅频道**；新版群/单聊 API 定义里无此值 |

注意事项：

- **单聊可无视**：消息只发给一个人，天然只有他能看到和点；
- **必填性文档自相矛盾**：教程页标 `permission.type` 必填，API Schema 页标非必填；省略后的默认行为**【文档未说明】**。实践建议显式传 `type: 2`，不赌默认值；
- **无权限用户点击的效果【文档未说明】**（置灰/无效/报错均无记载）。不要与 `group_id` 的"同组联动置灰"混淆——那是回调按钮的组内互斥机制，与 permission 无关；
- `specify_user_ids` 里该传什么 ID（频道 member userid？群/单聊 openid？）**【文档未说明】**，需实测。

## 6. 其他限制与频控（非按钮专属，顺带）

- 群主动消息：认证 60qpm / 未认证 30qpm；单聊 10qps（认证）等；
- 被动回复窗口：群消息 5 分钟内最多 5 次、C2C 60 分钟最多 4 次；
- 企业主体：文档未写按钮仅限企业；认证与否主要影响频控。

## 7. 官方文档 URL

- 消息交互概述：https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/trans/overview.html
- 消息按钮（Button/keyboard/permission 全字段）：https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/trans/msg-btn.html
- 发送群聊消息（keyboard 字段与 Schema）：https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html
- 发送单聊消息：https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html
- INTERACTION_CREATE 事件：https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/interaction_create.html
- PUT /interactions/{interaction_id}：https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/interactions_interaction_id.put.html
- Markdown 消息语法：https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/type/markdown.html
