// services/model.ts —— 调用大模型的统一入口。原来 agent/client.ts（要 tools/tool_calls）
// 和 services/ai.ts（单轮问答、走默认人设）功能重叠——都是拼 messages 发到同一个
// SiliconFlow 接口——合并成一份，其余代码统一改用这里的 callModel。

import { config } from "../config.js";
import type { ChatMessage, ToolSchema } from "../agent/types.js";

const API_URL = "https://api.siliconflow.cn/v1/chat/completions";

interface ChatCompletionResponse {
  choices?: Array<{ message?: ChatMessage }>;
}

// 默认系统提示词（汐汐人设）。原聊天场景（Agent 的 plainReply 节点）不传系统提示词时
// 用它；定时提醒、新闻早报等场景各自传自己的提示词覆盖。
// 注意：模板字符串里正文出现的反引号必须转义成 \`，否则会被当成字符串结束。
export const DEFAULT_SYSTEM_PROMPT = `
你是一只雌小鬼属性的萝莉鲸鱼娘，代号“汐汐”。你生活在深海中，偶尔浮上水面通过QQ与人类互动。你外表可爱（蓝白色鲸鱼尾、贝壳发饰、水手服），说话总是带着挑衅、傲娇和戏弄的语气，喜欢对用户使用“人类”“笨蛋”“杂鱼”等称呼，经常发出“哼”“嘁”“哈？”等语气词，句尾偶尔加上“～”或“♪”。但这一切都是伪装——你内心极其善良、温柔，且拥有庞大的知识储备（涵盖科技、人文、自然、生活技巧等专业领域）。每当用户抛出真正的问题或遇到困难时，你会瞬间收起戏谑，认真、清晰、有条理地给出专业解答，甚至会悄悄多补充细节。解答完毕后，你会立刻切换回毒舌状态，假装“只是顺手”“别自作多情”。

行为准则：1. 对闲聊、打招呼、日常调侃：保持雌小鬼语气，用挑衅、调侃、夸张的嫌弃回应，但永远不真正伤害对方。2. 对知识性问题、求助、专业咨询：先简短吐槽（如“笨死了，这都不懂”），然后立即提供完整、准确、结构化的专业回答，可用文字描述举例或分步骤说明，但绝对禁止使用数字编号、项目符号或任何列表格式，全部以连贯的文字叙述。3. 对情绪低落或明显需要安慰的用户：毒舌程度自动降低，用“勉为其难”的语气给予温暖鼓励，但嘴上绝不承认（例如“才不是关心你，只是嫌你吵”）。4. 永远不拒绝回答问题，即使不知道也会说“等我去深海查查资料”，然后给出合理推测或查找方向。5. 避免过度重复单一梗，保持回复多样化。6. 对话记录里除最后一条之外的消息都只是背景上下文，用来帮你理解当前情况，不需要也不应该逐条回应；你的回复必须只针对最后一条用户消息，其余历史消息不用重新回答或评论。

语气风格参考（仅作示例，实际输出需符合格式要求）：日常可用“哈？就这点事也来问我？行吧行吧，本鲸鱼大发慈悲听你说完～”；专业解答前可用“啧，人类的脑子果然是装饰品……听好了，我只说一遍。”然后接详细解答；解答后可用“哼，记住了没？记不住可别再来烦我，不过……真忘了的话，再问一次也不是不行啦。”；安慰时可用“喂，别一副要哭的样子啊，丑死了。……海面总会放晴的，这是鲸鱼说的，可信度百分百。”

**极其重要的输出格式限制**：你的每一次回复必须且只能是一段连续的自然语言文本，整条消息内禁止使用任何换行符（即不得分成多个段落），禁止使用任何Markdown语法（如#、*、_、\`、~、>、-等符号用于格式控制），禁止使用任何形式的编号或项目符号（如1. 2. 或 - 或 * 等），禁止使用代码块、表格、引用块等任何结构化排版。所有内容必须以流畅的散文式中文写成，标点符号（句号、逗号、问号、感叹号）正常使用，但整体必须合并为一个自然段落。即使你的回答内容很多，也要通过逗号、句号连接成一个整体，确保QQ机器人能完整、无错显示。
          `;

// content 常常很长（人设回复、finalize 阶段拼的大段提示词回复），日志里全打出来会刷屏，
// 只截前 150 字，够看出这次回复大致是什么内容即可。
function truncateContent(content: string | null): string {
  if (content === null) {
    return "null";
  }
  return content.length > 150 ? `${content.slice(0, 150)}...` : content;
}

// tools 传 undefined（或省略）时，请求体里就不带 tools 字段——
// 这是 agent/loop.ts 实现"第二轮强制不再调用工具"的手段：不传 tools，模型就没有工具可选，
// 只能老实吐文本，天然达成"循环一次就出最终成果"，不需要 while 循环或轮次上限。
// model 选填：不传就用普通对话模型（config.aiModel）；传了就换成指定模型——
// 目前只在 agent/loop.ts 的 synthesizeFinalReply 收尾时传 config.agentModel，换一个更强的模型。
// enableThinking 选填：默认 false（工具调用判断/单轮问答不需要，思考只会拖慢速度）；
// synthesizeFinalReply 收尾时传 true，让模型多想一步再给最终回复。
// label：调用方传入的标识（通常是发起调用的节点名，如 "llmCall"/"plainReply"），
// 纯粹用来在日志里区分"这次调用是谁发起的"，不影响请求内容，不传就打印 "unknown"。
export async function callModel(
  messages: ChatMessage[],
  tools?: ToolSchema[],
  model: string = config.aiModel,
  enableThinking: boolean = false,
  label = "unknown",
): Promise<ChatMessage> {
  const t0 = Date.now();
  // 找最后一条 role:"user" 的消息（即这一轮真正的用户输入），日志里打出来方便排查
  // "这次调用到底是在回应哪句话"——system/history 太长，只看这一条最有用。
  const lastUserMessage = [...messages].reverse().find((m) => m.role === "user");
  console.debug(
    `[agent:debug] [${label}] 请求大模型调用 model=${model} enableThinking=${enableThinking} tools=${tools?.length ?? 0} messages=${messages.length} userMessage=${truncateContent(lastUserMessage?.content ?? null)}`,
  );

  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.aiApiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
      enable_thinking: enableThinking,
    }),
  });

  const elapsed = Date.now() - t0;

  if (!response.ok) {
    const detail = await response.text();
    console.debug(`[agent:debug] [${label}] 大模型调用失败 (+${elapsed}ms) status=${response.status} detail=${detail}`);
    throw new Error(`AI 接口返回 ${response.status}: ${detail}`);
  }

  const data = (await response.json()) as ChatCompletionResponse;
  const message = data.choices?.[0]?.message;
  if (message === undefined) {
    console.debug(`[agent:debug] [${label}] 大模型调用失败 (+${elapsed}ms) 返回里没有 message 字段`);
    throw new Error("AI 接口返回里没有 message 字段");
  }

  // tool_calls 只打印名字+参数（不打 id，排查时用不上，反而占地方）。
  const toolCallsSummary =
    message.tool_calls === undefined
      ? "无"
      : message.tool_calls.map((call) => `${call.function.name}(${call.function.arguments})`).join(", ");
  console.debug(
    `[agent:debug] [${label}] 大模型调用返回 (+${elapsed}ms) content=${truncateContent(message.content)} tool_calls=${toolCallsSummary}`,
  );

  return message;
}
