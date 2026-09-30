// qq/keyboard.ts —— 消息按钮（keyboard）的构造层。
// 与 messages.ts 同层：这里只描述"按钮长什么样"（框架知识），不管发给谁
//（那是 messages.ts 的事），更不管按钮背后是什么业务（那是 service 的事）。
// 依据 docs/features/2026-09-05-QQ机器人消息按钮keyboard详解.md：
// - 按钮是 Markdown 消息（msg_type=2）的配套能力，随 keyboard 字段一起发；
// - 长形式（自定义布局）标注【内邀开通】，能否使用需真机验证（方案实验 1）；
// - 上限 5 行 × 每行 5 按钮（超限错误码 40034029）；
// - permission 显式传值，不赌省略后的默认行为（文档对必填性自相矛盾）。

// 谁有资格点这个按钮（详解文档 §5）。type 含义：
//   0 = 指定用户可操作（specify_user_ids 列名单——传什么 ID 文档未说明，
//       真机验证为 member_openid/user_openid，见方案实验 2）
//   1 = 仅管理员可操作（"管理员"判定范围文档未说明——群管/群主/机器人管理员，见实验 2）
//   2 = 所有人可操作（显式声明，不用省略默认值）
// type=3 仅频道可用，不进本类型。
export type ButtonPermission =
  | { type: 0; specify_user_ids: string[] }
  | { type: 1 }
  | { type: 2 };

// Button 结构（详解文档 §3）。当前只用到跳转按钮（type=0）所需字段的子集；
// 回调（type=1）/指令（type=2）按钮将来要用时再补全 action 的可选字段。
export interface KeyboardButton {
  id: string;
  render_data: {
    label: string;
    visited_label: string;
    style: number;
  };
  action: {
    type: 0; // 跳转按钮：点击后客户端打开 data 里的链接
    permission: ButtonPermission;
    data: string;
    unsupport_tips: string;
  };
}

// 构造一个跳转按钮（action.type=0）。
// label 上限 10 字符——超限是调用方笔误，宁可当场抛错（开发期发现），
// 不等 QQ 返回 40034029 再去服务器日志里找。
export function jumpButton(
  id: string,
  label: string,
  url: string,
  permission: ButtonPermission = { type: 2 },
): KeyboardButton {
  if (label.length > 10) {
    throw new Error(`按钮 label 超过 10 字符：「${label}」`);
  }
  return {
    id,
    render_data: {
      label,
      visited_label: label, // 点击后显示的文字；跳转按钮无状态变化，保持原样
      style: 1, // 蓝线框（详解文档 §3：0 灰线框 / 1 蓝线框 / 3 白底红字 / 4 蓝底白字）
    },
    action: {
      type: 0,
      permission,
      data: url,
      unsupport_tips: "当前客户端不支持按钮跳转",
    },
  };
}

// 把按钮按行包成 keyboard 字段的长形式。
// 行数 ≤5、每行 ≤5、按钮 id 全键盘唯一——都是上限约束，超限当场抛错（同上理由）。
export function keyboardOf(rows: KeyboardButton[][]): {
  content: { rows: Array<{ buttons: KeyboardButton[] }> };
} {
  if (rows.length > 5) {
    throw new Error(`keyboard 超过 5 行（收到 ${rows.length} 行）`);
  }
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.length > 5) {
      throw new Error(`keyboard 单行超过 5 个按钮（收到 ${row.length} 个）`);
    }
    for (const btn of row) {
      if (seen.has(btn.id)) {
        throw new Error(`keyboard 内按钮 id 重复：「${btn.id}」`);
      }
      seen.add(btn.id);
    }
  }
  return { content: { rows: rows.map((buttons) => ({ buttons })) } };
}
