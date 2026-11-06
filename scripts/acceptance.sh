#!/usr/bin/env bash
# 阶段验收 gate —— 每个阶段一条命令，失败即非零退出（可直接接 CI）。
#
# 用法：
#   bash scripts/acceptance.sh p0     只验地基
#   bash scripts/acceptance.sh p2     验最小闭环
#   bash scripts/acceptance.sh all    跑全部已实现阶段
#
# 规则：任何一步失败都会汇总到最后，整个脚本返回非零。
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

phase="${1:-all}"
fail=0

step() { printf '\n▸ %s\n' "$*"; }

# 跑一条命令并记录失败，不中断后续检查（一次看清所有问题）
run() {
  step "$*"
  if ! "$@"; then
    echo "   ✗ 失败"
    fail=1
  fi
}

if [ ! -d node_modules ]; then
  echo "缺少依赖，先运行: bun install"
  exit 2
fi

# 所有阶段共用的基线：类型 + 单元测试
baseline() {
  run bun run typecheck
  run bun test
}

case "$phase" in
  p0)
    baseline
    run bun run src/index.ts --help
    ;;
  p1)
    baseline
    run bun run src/index.ts --list-providers
    ;;
  p2)
    baseline
    run bun run smoke
    ;;
  p3 | p4 | p5 | p6 | p7 | p8 | p9 | p10 | p11 | p12)
    baseline
    echo "该阶段尚未实现，只跑了基线检查"
    echo "任务清单与手工验收项见 ROADMAP.md 的 $(echo "$phase" | tr '[:lower:]' '[:upper:]') 小节"
    ;;
  all)
    baseline
    run bun run src/index.ts --list-providers
    run bun run smoke
    echo "P3+ 尚未实现，已跳过"
    ;;
  *)
    echo "用法: bash scripts/acceptance.sh [p0|p1|p2|all]"
    exit 2
    ;;
esac

if [ "$fail" -ne 0 ]; then
  printf '\nGATE FAILED (%s)\n' "$phase"
  exit 1
fi
printf '\nGATE PASSED (%s)\n' "$phase"
