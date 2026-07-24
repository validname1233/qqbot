// events/raw.ts —— QQ 推来的原始事件「外层信封」。
// 所有事件的外层都长这样，只有 d 的形状随 t 变化。所以这个信封只定义一次，
// 各种具体事件不用重复抄 op/id/t，只需各自解析自己的 d。

// op 0 的 body：{ op:0, id, t:"C2C_MESSAGE_CREATE", d:{...} }
// t 是事件类型字符串，d 是该事件的数据。d 随 t 变化，先按 unknown 收着，
// 由每种事件的 parse 各自收窄。
export interface RawEvent {
  op: number;
  id?: string;
  t?: string;
  d?: unknown;
}
