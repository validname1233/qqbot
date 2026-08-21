#!/usr/bin/env bash
# test/recall/run.sh —— 长期记忆召回测试的一键入口（Git Bash）。
# 用法：
#   ./run.sh all              # 清库 → 灌 100 条（真实 embedding，约 1 分钟）→ 全模式评测
#   ./run.sh seed [--force]   # 只灌库（已灌跳过；--force 清空重灌）
#   ./run.sh test [--verbose] # 只评测（读 config.json；--verbose 逐条打印命中情况）
#   ./run.sh reset            # 删测试库文件
set -euo pipefail
cd "$(dirname "$0")/../.."   # 回到项目根

ENV_FILE=".env"
if [ ! -f "$ENV_FILE" ]; then
  echo "缺少 $ENV_FILE（复制 .env.example 并填好 key 后再跑）" >&2
  exit 1
fi

# 独立测试库：覆盖到 data/recall-test.sqlite（data/ 已被 .gitignore 忽略），
# 与生产 memory.sqlite 文件级隔离。进程内 export 的变量不会被 --env-file 覆盖冲突。
export MEMORY_DB_PATH="recall-test.sqlite"

CMD="${1:-test}"
case "$CMD" in
  seed)
    npx tsx --env-file="$ENV_FILE" test/recall/seed.ts "${@:2}"
    ;;
  test)
    npx tsx --env-file="$ENV_FILE" test/recall/eval.ts "${@:2}"
    ;;
  reset)
    rm -f data/recall-test.sqlite data/recall-test.sqlite-wal data/recall-test.sqlite-shm
    echo "[reset] 已删除测试库 data/recall-test.sqlite"
    ;;
  all)
    "$0" reset
    "$0" seed
    "$0" test "${@:2}"
    ;;
  *)
    echo "用法：./run.sh all|seed|test|reset [--verbose|--force]" >&2
    exit 1
    ;;
esac
