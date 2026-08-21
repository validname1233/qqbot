# test/recall —— 长期记忆召回准确率测试

对长期记忆的混合检索（向量 RAG + 关键词 BM25 + RRF 融合）做准确率评测。测试**直接复用生产代码**（`hybridRecall`），测出来的数字就是线上行为的数字；测试库是独立文件，与生产 `memory.sqlite` 完全隔离。

## 前置条件

1. **Git Bash**（run.sh 是 bash 脚本）；
2. 项目根目录有 `.env`，且 `EMBEDDING_API_KEY` 是真实的智谱 key（灌库和 rag/hybrid 模式要调真 embedding 接口，全程约 130 次调用，成本几分钱）。没有就 `cp .env.example .env` 后填好；
3. 依赖已安装：`npm install`。

## 快速开始

```bash
cd test/recall
./run.sh all        # 一键：清库 → 灌 100 条测试记忆（约 1 分钟）→ 三模式评测出表
```

结束会打印这样的对比表：

```
参数：topK=5  minSimilarity=0.35  rrfK=60  hybrid权重 vec:kw=1:1  bm25 k1/b=1.5/0.75
rag       Recall@5=0.xxx  MRR=0.xxx  全对=xx  部分=xx  全miss=xx
keyword   Recall@5=0.xxx  MRR=0.xxx  全对=xx  部分=xx  全miss=xx
hybrid    Recall@5=0.xxx  MRR=0.xxx  全对=xx  部分=xx  全miss=xx
```

## 四个命令

| 命令 | 作用 |
|---|---|
| `./run.sh all` | reset → seed → test 一条龙（首次使用 / 换了语料后用这个） |
| `./run.sh seed` | 灌库。已灌过会跳过；`./run.sh seed --force` 清空重灌 |
| `./run.sh test` | 只评测（改了 config.json 之后跑这个，秒级，只调 query 侧 embedding） |
| `./run.sh reset` | 删掉测试库文件，彻底清场 |

评测加 `--verbose` 可以逐条看每个 query 在每个模式下的命中情况（`M006✓ M013✗ ...`），定位 badcase 用：`./run.sh test --verbose`。

## 三种模式与调参（config.json）

```json
{
  "modes": ["rag", "keyword", "hybrid"],   // 这次评测跑哪几种模式
  "topK": 5,                                // 召回条数（与生产 TOP_K 一致）
  "minSimilarity": 0.35,                    // 向量通道余弦门槛
  "rrfK": 60,                               // RRF 融合常数
  "vecWeight": 1.0, "kwWeight": 1.0,        // hybrid 模式的通道权重
  "bm25K1": 1.5, "bm25B": 0.75              // BM25 参数
}
```

- **`rag`**：纯向量召回（`vecWeight:1, kwWeight:0` 的预设，关键词通道整体关闭）；
- **`keyword`**：纯 BM25 召回（反向预设，连 embedding 都不调）；
- **`hybrid`**：加权 RRF，读 `vecWeight`/`kwWeight`——`1:1` 就是生产行为，`0.7:0.3` 之类的偏置实验也在这里调。

**调参流程**：改 `config.json`（比如只留 `"modes": ["hybrid"]`，把权重改成 `0.7/0.3`）→ `./run.sh test` → 对比表。同一次运行里多个模式共用同一批 query embedding，模式间对比是公平的。

## 换自己的测试数据

数据在 `data/` 下两个 JSON，改完 `./run.sh all` 重灌重测：

- **`corpus.json`**：`[{ "id": "M001", "content": "记忆正文", "memory_index": "摘要" }, ...]`。`content` 必须全局唯一（评测靠它映射回 id），`memory_index` 直接给字符串（不走 LLM 生成，保证可复现）；
- **`queries.json`**：`[{ "query": "我对什么过敏？", "gold": ["M006", "M099"] }, ...]`。`gold` 是这条 query「直接回答所必需」的记忆 id 列表，可多条。标注口径：相关但非必需的不进 gold。

## 指标含义

- **Recall@topK**：该召回的召回了多少（主指标，越高越好）；
- **MRR**：第一条正确结果排得多靠前（排序质量）；
- **全对/部分/全miss**：每条 query 的命中分布，用来定位是哪类查询拉垮了指标。

## 常见问题

- **`缺少 .env`** → 按前置条件第 2 条处理；
- **想看每条记忆在库里的样子** → 测试库在 `data/recall-test.sqlite`，任何 SQLite 工具都能打开，表结构和生产完全相同；
- **测试会污染生产记忆吗** → 不会。测试库是独立文件（`MEMORY_DB_PATH=recall-test.sqlite` 只在 run.sh 进程里生效），生产 `memory.sqlite` 不会被打开；
- **rag/keyword 某个模式特别差** → 见 `方案.md` 第 8 节的解读框架：先看失败 query 属于字面型还是语义型，再对应调 `minSimilarity` / 分词器 / 权重。

## 文件一览

| 文件 | 职责 |
|---|---|
| `方案.md` | 完整设计文档（为什么这么测、指标定义、边界说明） |
| `run.sh` | 一键入口，负责切目录、export 隔离变量、调 tsx |
| `seed.ts` / `eval.ts` | 灌库 / 评测脚本 |
| `config.json` | 唯一需要动的配置 |
| `data/*.json` | 语料 + 标注，可整体替换 |
