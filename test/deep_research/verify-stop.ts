// test/deep_research/verify-stop.ts —— /stop 中断链路的单元验证（不调真实模型）。
// 验证点：拒绝并发语义、abortFlow 拉闸、endControlledFlow 身份校验防误删。
// 用法：npx tsx --env-file=.env test/deep_research/verify-stop.ts

import {
  beginControlledFlow,
  endControlledFlow,
  abortFlow,
} from "../../src/session/interrupt.js";

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}`);
  }
}

// 1. 拒绝并发：同 key 第二个 begin 返回 null
const ctrl1 = beginControlledFlow("group:G:A");
check("首个登记成功", ctrl1 !== null);
check("同 key 再登记被拒绝", beginControlledFlow("group:G:A") === null);
// 跨 key 不受影响（隔离）
const ctrlB = beginControlledFlow("group:G:B");
check("不同 key 登记不受影响", ctrlB !== null);

// 2. abortFlow：拉闸 + 返回 true；无条目返回 false
check("abort 拉闸返回 true", abortFlow("group:G:A") === true);
check("拉闸后 signal.aborted", ctrl1?.signal.aborted === true);
check("再次 abort 返回 false", abortFlow("group:G:A") === false);
check("B 的 signal 未被误伤", ctrlB?.signal.aborted === false);

// 3. 身份校验：旧流程的 end 不删新流程的条目（"顶掉"语义的保险，虽当前是拒绝语义）
const ctrlNew = beginControlledFlow("group:G:A"); // 旧的已删，新的能进
endControlledFlow("group:G:A", ctrl1 as AbortController); // 旧 controller 迟到的 finally
check("旧 controller 的 end 不影响新条目", abortFlow("group:G:A") === true); // 新条目还在，能被 abort

// 4. 正常收尾：end 后能重新登记（先把第 2 步遗留的 ctrlB 清干净）
endControlledFlow("group:G:B", ctrlB as AbortController);
const ctrl3 = beginControlledFlow("group:G:B");
check("正常注销后可重新登记", ctrl3 !== null);
endControlledFlow("group:G:B", ctrl3 as AbortController);
check("再次注销后仍可登记", beginControlledFlow("group:G:B") !== null);
abortFlow("group:G:B"); // 清理，留给后续测试干净状态

console.log(failures === 0 ? "\n[verify-stop] 全部通过 ✓" : `\n[verify-stop] ${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
