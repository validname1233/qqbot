// agent/code-workspace/tools/shared.ts —— 六件套共用的小件：参数取值与错误格式化。
// 工具实现里参数来自模型的 JSON（args: Record<string, unknown>），取值要收窄类型；
// 出错信息直接回给模型当"纠错线索"，措辞按"可自纠"标准写。

// 取 string 参数：缺失/类型不符返回 undefined（调用方给默认或报错）。
export function asString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" ? v : undefined;
}

// 取正整数参数（offset/limit 这类）：0/负数/非数字都算没传。
export function asPositiveInt(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (typeof v === "number" && Number.isInteger(v) && v > 0) return v;
  return undefined;
}

// 工具结果的标准错误格式：模型读得懂、知道下一步怎么改。
export function toolError(what: string, detail: string): string {
  return `[失败] ${what}：${detail}`;
}
