// agent/code-workspace/tools/exec.ts —— 六件套之六：exec（唯一走容器的工具）。
// 任务容器由 run-task 的 executor 管理（容器随任务创建/销毁），本工具只是把
// 模型给的命令发进容器执行：docker exec <容器> timeout N bash -lc '<命令>'。
// workspace 由服务端注入（挂载），模型唯一能决定的是命令字符串本身。
//
// 容器句柄经模块级 currentContainer 传递（同一任务内共享、任务间互斥由闸保证，
// 不存在并发写它的场景）——避免把 executor 对象塞进 MessageContext（那是公共契约）。

import type { Tool } from "../../tool.js";
import type { MessageContext } from "../../../types.js";
import { execInContainer, ExecutorError } from "../../../services/workspace/executor.js";
import { asString, toolError } from "./shared.js";

// run-task 在任务开始时 set、结束时 clear；工具执行期读。
let currentContainer: string | null = null;

export function setCurrentContainer(container: string | null): void {
  currentContainer = container;
}

export const execTool: Tool = {
  name: "exec",
  description:
    "在 workspace 的 Linux 容器中以 bash 执行命令并返回 stdout/stderr/退出码。" +
    "环境已预装 python3 + numpy/pandas/matplotlib（无网络，pip 装不了包）。" +
    "当前工作目录就是 workspace 根。单条命令 60 秒超时（超时会被强制终止，" +
    "exit code 124）。跑脚本用 'python main.py'；删文件、看目录等系统操作也走这里。",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "要执行的 bash 命令" },
    },
    required: ["command"],
  },
  progressNote: (args) => {
    const cmd = typeof args["command"] === "string" ? args["command"] : "";
    const head = cmd.split(/\s+/).slice(0, 3).join(" ");
    return `正在执行命令：${head}${cmd.length > 30 ? "…" : ""}`;
  },

  async run(args, ctx: MessageContext): Promise<string> {
    const command = asString(args, "command");
    if (command === undefined || command.trim() === "") {
      return toolError("exec", "缺少 command 参数");
    }
    if (currentContainer === null) {
      return toolError("exec", "任务容器未运行（内部状态异常），请停止当前任务重试");
    }

    try {
      const result = await execInContainer(currentContainer, command);
      const parts: string[] = [];
      parts.push(`[exit ${result.exitCode}] (${(result.durationMs / 1000).toFixed(1)}s)`);
      if (result.stdout.trim() !== "") parts.push(`stdout:\n${result.stdout.trimEnd()}`);
      if (result.stderr.trim() !== "") parts.push(`stderr:\n${result.stderr.trimEnd()}`);
      if (result.stdout.trim() === "" && result.stderr.trim() === "") {
        parts.push("（无输出）");
      }
      return parts.join("\n");
    } catch (err) {
      if (err instanceof ExecutorError) {
        return toolError("exec", err.message);
      }
      return toolError("exec", err instanceof Error ? err.message : String(err));
    }
  },
};
