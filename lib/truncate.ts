import { INPUT_TRUNCATE_TOKENS } from "@/prompts";

/**
 * 输入文本截断。
 *
 * 截断逻辑独立成文件的原因（PD-06 第 4.3 节）：截断上限与策略需要
 * 被单独测试和调整，不应与 Prompt 构造或模型调用耦合。
 *
 * 当前实现为字符数折算的近似估算（英文约 4 字符 / token），
 * 项目未引入分词器，避免为此增加依赖。折算系数可在此处单点调整。
 */

/** 折算系数：每个 token 约对应的字符数 */
const CHARS_PER_TOKEN = 4;

/** 估算文本的 token 数 */
export function estimateTokenCount(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * 将文本截断到指定 token 上限。
 *
 * 未超限时原样返回；超限时按字符预算截取，并尽量在最后的空白字符处断开，
 * 避免产生半个单词。不追加截断标记——v1.0 的 Prompt 未对标记作任何约定，
 * 追加标记会引入 Prompt 之外的额外信息。
 */
export function truncateToTokenLimit(
  text: string,
  maxTokens: number = INPUT_TRUNCATE_TOKENS,
): string {
  if (estimateTokenCount(text) <= maxTokens) return text;

  const maxChars = maxTokens * CHARS_PER_TOKEN;
  const sliced = text.slice(0, maxChars);
  const lastWhitespace = Math.max(sliced.lastIndexOf(" "), sliced.lastIndexOf("\n"));

  return lastWhitespace > maxChars * 0.9 ? sliced.slice(0, lastWhitespace) : sliced;
}
