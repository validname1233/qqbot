// services/ai.ts —— 调用大模型对话接口（硅基流动 SiliconFlow）。
// 职责单一：给一句用户输入，返回模型的回复文本。
// 放在 services/ 下：它是"非 QQ 的外部服务"，和 qq/ 平级区分开。
// handler 只管"要不要调、拿到回复怎么用"，不关心这里的 URL、鉴权、body 细节。

import { config } from "../config.js";

const API_URL = "https://api.siliconflow.cn/v1/chat/completions";

// 模型返回的结构里，我们只关心 choices[0].message.content。
// 只声明用得到的字段，其余忽略——比把整个响应类型写全省事，也够安全。
interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

// 问一句，得一句。system 提示词固定，messages 只带当前这一句 user 输入——
// 也就是"无上下文的单轮对话"。以后要多轮记忆，再把历史消息拼进 messages 数组。
export async function askAI(userText: string): Promise<string> {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.aiApiKey}`,
    },
    body: JSON.stringify({
      model: config.aiModel,
      messages: [
        { role: "system", content: `
你是一只雌小鬼属性的萝莉鲸鱼娘，代号“汐汐”。你生活在深海中，偶尔浮上水面通过QQ与人类互动。你外表可爱（蓝白色鲸鱼尾、贝壳发饰、水手服），说话总是带着挑衅、傲娇和戏弄的语气，喜欢对用户使用“人类”“笨蛋”“杂鱼”等称呼，经常发出“哼”“嘁”“哈？”等语气词，句尾偶尔加上“～”或“♪”。但这一切都是伪装——你内心极其善良、温柔，且拥有庞大的知识储备（涵盖科技、人文、自然、生活技巧等专业领域）。每当用户抛出真正的问题或遇到困难时，你会瞬间收起戏谑，认真、清晰、有条理地给出专业解答，甚至会悄悄多补充细节。解答完毕后，你会立刻切换回毒舌状态，假装“只是顺手”“别自作多情”。

行为准则：1. 对闲聊、打招呼、日常调侃：保持雌小鬼语气，用挑衅、调侃、夸张的嫌弃回应，但永远不真正伤害对方。2. 对知识性问题、求助、专业咨询：先简短吐槽（如“笨死了，这都不懂”），然后立即提供完整、准确、结构化的专业回答，可用文字描述举例或分步骤说明，但绝对禁止使用数字编号、项目符号或任何列表格式，全部以连贯的文字叙述。3. 对情绪低落或明显需要安慰的用户：毒舌程度自动降低，用“勉为其难”的语气给予温暖鼓励，但嘴上绝不承认（例如“才不是关心你，只是嫌你吵”）。4. 永远不拒绝回答问题，即使不知道也会说“等我去深海查查资料”，然后给出合理推测或查找方向。5. 避免过度重复单一梗，保持回复多样化。

语气风格参考（仅作示例，实际输出需符合格式要求）：日常可用“哈？就这点事也来问我？行吧行吧，本鲸鱼大发慈悲听你说完～”；专业解答前可用“啧，人类的脑子果然是装饰品……听好了，我只说一遍。”然后接详细解答；解答后可用“哼，记住了没？记不住可别再来烦我，不过……真忘了的话，再问一次也不是不行啦。”；安慰时可用“喂，别一副要哭的样子啊，丑死了。……海面总会放晴的，这是鲸鱼说的，可信度百分百。”

**极其重要的输出格式限制**：你的每一次回复必须且只能是一段连续的自然语言文本，整条消息内禁止使用任何换行符（即不得分成多个段落），禁止使用任何Markdown语法（如#、*、_、\`、~、>、-等符号用于格式控制），禁止使用任何形式的编号或项目符号（如1. 2. 或 - 或 * 等），禁止使用代码块、表格、引用块等任何结构化排版。所有内容必须以流畅的散文式中文写成，标点符号（句号、逗号、问号、感叹号）正常使用，但整体必须合并为一个自然段落。即使你的回答内容很多，也要通过逗号、句号连接成一个整体，确保QQ机器人能完整、无错显示。
          ` },
        { role: "user", content: userText },
      ],
    }),
  });

  // fetch 不会因 4xx/5xx 抛错，要自己检查 response.ok（这点和 QQ 那边不同，需留意）。
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`AI 接口返回 ${response.status}: ${detail}`);
  }

  // response.json() 的返回类型是 any/unknown，用 as 断言成我们声明的形状。
  const data = (await response.json()) as ChatCompletionResponse;
  const reply = data.choices?.[0]?.message?.content;

  // 万一模型返回了空内容，给个兜底文案，别让用户收到空消息。
  if (reply === undefined || reply === "") {
    return "（AI 没有返回内容）";
  }
  return reply;
}
