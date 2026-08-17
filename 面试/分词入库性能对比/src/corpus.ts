// corpus.ts —— 合成语料与查询集：用固定种子的伪随机数生成"长得像长期记忆"的
// 中文短句。种子固定 → 每次运行同一规模生成完全相同的语料，保证可复现、两组公平。

// mulberry32：32 位确定性 PRNG，6 行实现，够这个用途。
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 词池：参照真实长期记忆的内容分布（人物、活动、食物、时间、地点）。
const NAMES = ["小明", "小红", "张三", "李四", "王五", "赵六", "汐汐", "妈妈", "爸爸", "老师", "老板", "同事"];
const ACTIVITIES = ["打羽毛球", "打游戏", "看电影", "爬山", "钓鱼", "唱歌", "跑步", "学英语", "写代码", "画画", "健身", "旅游"];
const FOODS = ["火锅", "蛋糕", "咖啡", "奶茶", "苹果", "面条", "寿司", "烧烤", "饺子", "奶茶"];
const TIMES = ["周一", "周三", "周五", "周末", "明天", "下周", "3月5日", "6月18日", "12月", "每天早上", "晚上八点"];
const PLACES = ["公司", "学校", "图书馆", "健身房", "家里", "公园", "海边", "商场"];

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

// 模板池：随机组合词池填空，长度落在真实记忆的量级（10~30 字）。
const TEMPLATES: Array<(rng: () => number) => string> = [
  (r) => `${pick(r, NAMES)}的生日是${pick(r, TIMES)}`,
  (r) => `${pick(r, NAMES)}喜欢${pick(r, ACTIVITIES)}，一般去${pick(r, PLACES)}`,
  (r) => `${pick(r, NAMES)}不爱吃${pick(r, FOODS)}，但喜欢${pick(r, FOODS)}`,
  (r) => `${pick(r, NAMES)}在${pick(r, TIMES)}要${pick(r, ACTIVITIES)}`,
  (r) => `记得${pick(r, TIMES)}提醒${pick(r, NAMES)}去${pick(r, PLACES)}${pick(r, ACTIVITIES)}`,
  (r) => `${pick(r, NAMES)}说${pick(r, PLACES)}的${pick(r, FOODS)}最好吃`,
  (r) => `${pick(r, NAMES)}下周要去${pick(r, PLACES)}出差，回来时带${pick(r, FOODS)}`,
  (r) => `${pick(r, TIMES)}在${pick(r, PLACES)}有${pick(r, ACTIVITIES)}的聚会`,
];

export function generateCorpus(size: number): string[] {
  const rng = mulberry32(size * 7919); // 种子绑定规模：同一规模 → 同一份语料
  const docs: string[] = [];
  for (let i = 0; i < size; i++) {
    docs.push(TEMPLATES[Math.floor(rng() * TEMPLATES.length)](rng));
  }
  return docs;
}

// 查询集：一半能命中词池（模拟真实召回），一半偏 miss（模拟查不到的 query）。
export function generateQueries(): string[] {
  return [
    "小明的生日是哪天",
    "谁喜欢打羽毛球",
    "周末要做什么",
    "汐汐是谁",
    "谁不爱喝咖啡",
    "下周三有什么安排",
    "谁在学英语",
    "打游戏一般去哪里",
    "量子计算机的原理",
    "黑洞的照片什么时候拍的",
    "股票行情怎么样",
    "世界杯决赛时间",
  ];
}
