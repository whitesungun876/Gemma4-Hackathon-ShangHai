/**
 * Plan Agent — 评估任务复杂度并生成执行计划。
 *
 * 使用方式：
 *   import { assessComplexity, generatePlan } from '@/agent/core/planAgent'
 *
 *   const { needsPlan, reason } = await assessComplexity(userMessage, llm)
 *   if (needsPlan) {
 *     const planItems = await generatePlan(userMessage, llm, systemPrompt)
 *   }
 */

import {
  chatRaw,
  streamChat,
  type ChatMessage,
  type LLMRequestParams,
} from '../llm/llmClient'
import type { ReActLLMConfig } from './reactAgent'
import type { PlanItem } from '../../types/task'

/** 规划阶段的流式回调（用于 UI 实时反馈） */
export interface PlanStreamCallbacks {
  /** 思考/推理 token（深度思考模型会产生 reasoning 内容） */
  onThinking?: (thinking: string) => void
  /** 文本 token（非最终输出，用于显示进度） */
  onToken?: (token: string) => void
}

/**
 * 辅助函数：使用流式调用并等待完成，同时转发生成的 token。
 * 如果流式调用返回空文本（部分 Ollama 版本不兼容 stream=true），
 * 自动回退到非流式 chatRaw 调用。
 */
async function streamAndWait(params: LLMRequestParams, callbacks?: PlanStreamCallbacks): Promise<string> {
  const streamedText = await new Promise<string>((resolve, reject) => {
    let accumulated = ''
    streamChat(params, {
      onToken(token: string) {
        accumulated += token
        callbacks?.onToken?.(token)
      },
      onThinking(thinking: string) {
        callbacks?.onThinking?.(thinking)
      },
      onComplete(text: string) {
        resolve(text || accumulated)
      },
      onError(error: Error) {
        reject(error)
      },
    })
  })

  // 流式调用返回空文本时，回退到非流式调用（部分 Ollama 版本即使 stream=true 也返回非流式格式，
  // 导致 SSE 解析器无法提取内容）
  if (!streamedText.trim()) {
    console.warn('[PlanAgent] 流式调用返回空文本，回退到非流式调用')
    try {
      const response = await chatRaw(params)
      const fallbackText = response.text || ''
      if (fallbackText.trim()) {
        // 将非流式结果通过 token 回调推送给 UI，确保用户能看到输出
        callbacks?.onToken?.(fallbackText)
      }
      // 回传 reasoning 内容（Ollama Gemma 4 的 reasoning 字段）
      if (response.reasoningContent) {
        callbacks?.onThinking?.(response.reasoningContent)
      }
      return fallbackText
    } catch (err) {
      console.error('[PlanAgent] 非流式回退也失败:', err)
      return streamedText // 返回原始空文本，让上层处理
    }
  }

  return streamedText
}

// ─── 工具函数 ──────────────────────────────────────────────────

/** 清理 LLM 响应中的工具调用标签 */
function cleanLLMResponse(text: string): string {
  text = text.replace(/<function-calls>[\s\S]*?<\/function-calls>/g, '')
  text = text.replace(/<function-call[^>]*>[\s\S]*?<\/function-call>/g, '')
  text = text.replace(/<function-call[^>]*\/?>/g, '')
  text = text.replace(/<\/function-call>/g, '')
  text = text.replace(/<parameter[^>]*>[\s\S]*?<\/parameter>/g, '')
  text = text.replace(/<\/parameter>/g, '')
  return text.trim()
}

/**
 * 从文本中提取 JSON 数组，支持多种格式：
 * - 纯 JSON 数组
 * - markdown 代码块中的 JSON
 * - 文本中嵌入的 JSON 数组
 */
function extractJsonArray(text: string): string | null {
  // 策略1: 直接从首字符 [ 开始匹配（最理想情况）
  const trimmed = text.trim()
  if (trimmed.startsWith('[')) {
    const lastBracket = trimmed.lastIndexOf(']')
    if (lastBracket > 0) {
      return trimmed.substring(0, lastBracket + 1)
    }
  }

  // 策略2: markdown 代码块
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/)
  if (codeBlockMatch) {
    const inner = codeBlockMatch[1].trim()
    if (inner.startsWith('[')) return inner
  }

  // 策略3: 平衡括号提取 — 找到第一个 [ 并匹配到对应的 ]
  const startIdx = text.indexOf('[')
  if (startIdx >= 0) {
    let depth = 0
    let inString = false
    let escape = false
    for (let i = startIdx; i < text.length; i++) {
      const ch = text[i]
      if (escape) { escape = false; continue }
      if (ch === '\\') { escape = true; continue }
      if (ch === '"') { inString = !inString; continue }
      if (inString) continue
      if (ch === '[') depth++
      else if (ch === ']') {
        depth--
        if (depth === 0) {
          return text.substring(startIdx, i + 1)
        }
      }
    }
  }

  return null
}

/**
 * 从文本中提取 JSON 对象
 */
function extractJsonObject(text: string): string | null {
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) {
    const lastBrace = trimmed.lastIndexOf('}')
    if (lastBrace > 0) return trimmed.substring(0, lastBrace + 1)
  }

  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/)
  if (codeBlockMatch) {
    const inner = codeBlockMatch[1].trim()
    if (inner.startsWith('{')) return inner
  }

  const jsonMatch = text.match(/\{[\s\S]*\}/)
  return jsonMatch ? jsonMatch[0] : null
}

// ─── 复杂度评估 ────────────────────────────────────────────────

/** 评估结果的返回类型 */
export interface ComplexityAssessment {
  /** 是否需要先进行计划 */
  needsPlan: boolean
  /** 评估理由 */
  reason: string
}

/**
 * 评估用户任务的复杂度，决定是否需要先进行计划。
 * 使用流式 LLM 调用，支持实时 thinking token 回调。
 */
export async function assessComplexity(
  userMessage: string,
  llm: ReActLLMConfig,
  callbacks?: PlanStreamCallbacks,
): Promise<ComplexityAssessment> {
  const systemPrompt = `你是一个任务复杂度评估专家。根据用户的任务描述，判断这个任务是否需要先进行详细规划再执行。

需要规划的任务特征：涉及多个步骤或阶段、需要操作多个文件或系统、有复杂的依赖关系、需要多轮决策
不需要规划的任务特征：单一明确的操作、简单的信息查询、直接的工具调用

你必须且只能回复一个 JSON 对象，格式如下，不要输出任何其他内容：
{"needsPlan": true, "reason": "简短理由"}`

  const messages: ChatMessage[] = [
    { role: 'user', content: userMessage },
  ]

  const params: LLMRequestParams = {
    baseUrl: llm.baseUrl,
    apiKey: llm.apiKey,
    format: llm.format,
    model: llm.model,
    messages,
    systemPrompt,
    temperature: 0.3,
    maxTokens: 200,
  }

  try {
    const rawText = await streamAndWait(params, callbacks)
    const cleaned = cleanLLMResponse(rawText.trim())
    const jsonStr = extractJsonObject(cleaned)

    if (jsonStr) {
      try {
        const parsed = JSON.parse(jsonStr) as ComplexityAssessment
        return {
          needsPlan: Boolean(parsed.needsPlan),
          reason: parsed.reason || '评估完成',
        }
      } catch {
        // JSON 解析失败，走回退逻辑
      }
    }

    // 回退：关键词推断
    const lowerText = rawText.toLowerCase()
    const needsPlan = lowerText.includes('needsplan') || lowerText.includes('需要规划') || lowerText.includes('需要计划')
    return { needsPlan, reason: '从响应文本推断' }
  } catch (err) {
    console.warn('[PlanAgent] 复杂度评估失败:', err)
    return {
      needsPlan: false,
      reason: `评估失败: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

// ─── 计划生成 ──────────────────────────────────────────────────

/** 计划生成的系统提示词 */
const PLAN_SYSTEM_PROMPT = `你是一个专业的任务规划师。你的唯一职责是将用户任务分解为可执行的步骤，并以纯 JSON 数组格式输出。

【输出规则 — 严格遵守】
- 必须输出且仅输出一个 JSON 数组，以 [ 开头，以 ] 结尾
- 禁止调用任何工具，禁止执行任何命令
- 禁止使用 <function-calls>、<function-call> 或任何 XML 标签
- 禁止输出任何解释、前言、思考过程、markdown 格式或其他非 JSON 文本
- 禁止使用 markdown 代码块（不要用 \`\`\` 包裹）

【计划要求】
1. 将任务分解为 3~10 个可执行步骤
2. 每个步骤清晰、具体、可验证
3. 步骤之间有明确的顺序和依赖关系
4. 计划完整覆盖任务的所有方面

【JSON 格式示例】
[
  {"title": "步骤标题", "description": "步骤详细描述"},
  {"title": "第二步", "description": "第二步描述"}
]

现在，请根据用户任务生成执行计划。直接输出 JSON 数组，不要包含任何其他内容。`

/** 解析 LLM 响应为 PlanItem 数组 */
function parsePlanResponse(rawText: string): PlanItem[] | null {
  const cleaned = cleanLLMResponse(rawText)
  const jsonStr = extractJsonArray(cleaned)

  if (!jsonStr) {
    console.error('[PlanAgent] 无法提取 JSON 数组，清理后文本:', cleaned.substring(0, 500))
    return null
  }

  try {
    const parsed = JSON.parse(jsonStr)
    if (!Array.isArray(parsed)) {
      console.error('[PlanAgent] 解析结果不是数组:', typeof parsed)
      return null
    }

    // 过滤并标准化每个步骤
    const planItems: PlanItem[] = []
    const timestamp = Date.now()
    for (let i = 0; i < parsed.length; i++) {
      const item = parsed[i]
      // 防御：跳过没有 title 的无效步骤
      if (!item || typeof item !== 'object' || !item.title) {
        console.warn(`[PlanAgent] 跳过无效步骤 #${i}:`, JSON.stringify(item))
        continue
      }
      planItems.push({
        id: `plan-${timestamp}-${planItems.length}`,
        title: String(item.title).trim(),
        description: item.description ? String(item.description).trim() : undefined,
        status: 'pending' as const,
        order: planItems.length,
      })
    }

    return planItems.length > 0 ? planItems : null
  } catch (err) {
    console.error('[PlanAgent] JSON 解析失败:', err instanceof Error ? err.message : String(err))
    console.error('[PlanAgent] 原始 JSON 字符串:', jsonStr.substring(0, 500))
    return null
  }
}

/**
 * 根据用户任务生成详细的执行计划。
 * 包含重试机制：首次失败后会再尝试一次。
 * 支持流式 thinking token 回调。
 * 返回 PlanItem 列表。
 */
export async function generatePlan(
  userMessage: string,
  llm: ReActLLMConfig,
  _systemPrompt?: string,
  callbacks?: PlanStreamCallbacks,
): Promise<PlanItem[]> {
  // 只传递用户任务，不传递包含工具信息的系统提示词
  // 这样可以避免 LLM 在规划阶段尝试调用工具
  const messages: ChatMessage[] = [
    { role: 'user', content: `[用户任务]\n${userMessage}` },
  ]

  const params: LLMRequestParams = {
    baseUrl: llm.baseUrl,
    apiKey: llm.apiKey,
    format: llm.format,
    model: llm.model,
    messages,
    systemPrompt: PLAN_SYSTEM_PROMPT,
    temperature: 0.4,
    maxTokens: 2000,
  }

  const MAX_RETRIES = 2
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`[PlanAgent] 开始生成计划 (第 ${attempt}/${MAX_RETRIES} 次)...`)
      const rawText = await streamAndWait(params, callbacks)
      console.log('[PlanAgent] LLM 原始响应 (前500字符):', rawText.substring(0, 500))

      const planItems = parsePlanResponse(rawText)
      if (planItems && planItems.length > 0) {
        console.log('[PlanAgent] 计划生成成功:', planItems.map(p => p.title).join(' | '))
        return planItems
      }

      console.warn(`[PlanAgent] 第 ${attempt} 次尝试未生成有效计划`)
    } catch (err) {
      console.error(`[PlanAgent] 第 ${attempt} 次尝试失败:`, err instanceof Error ? err.message : String(err))
    }
  }

  console.error('[PlanAgent] 所有尝试均失败，返回空计划')
  return []
}

// ─── 计划提示增强 ──────────────────────────────────────────────

/**
 * 将计划项目注入到系统提示中，指导 Agent 按计划执行。
 */
export function buildPlanAwarePrompt(planItems: PlanItem[]): string {
  if (planItems.length === 0) return ''

  const lines: string[] = [
    '',
    '# 执行计划',
    '请按以下计划执行任务。使用 update_plan_item 工具更新每个步骤的状态：',
    '- 开始执行时，将状态更新为 "in_progress"',
    '- 完成时，将状态更新为 "completed"',
    '- 失败时，将状态更新为 "failed"',
    '',
  ]

  for (const item of planItems) {
    const statusIcon = item.status === 'completed' ? '[✓]'
      : item.status === 'in_progress' ? '[→]'
      : item.status === 'failed' ? '[✗]'
      : '[ ]'
    lines.push(`${statusIcon} ${item.order + 1}. [ID: ${item.id}] ${item.title}`)
    if (item.description) {
      lines.push(`   ${item.description}`)
    }
  }

  lines.push('')
  lines.push('请按顺序执行上述计划，并在每个步骤开始和结束时使用 update_plan_item 更新状态。')
  lines.push('重要：请使用方括号中的 ID（如 "plan-xxxxx-x"）作为 item_id 参数，不要使用序号。')

  return lines.join('\n')
}

// ─── 合并评估 + 计划生成（一次 LLM 调用）──────────────────────

/** 合并评估 + 计划生成的结果 */
export interface AssessAndPlanResult {
  /** 是否需要计划 */
  needsPlan: boolean
  /** 评估理由 */
  reason: string
  /** 计划项（needsPlan 为 true 时非空） */
  planItems: PlanItem[]
}

/**
 * 一次 LLM 调用同时完成复杂度评估和计划生成。
 *
 * 相比分开调用 assessComplexity + generatePlan：
 *   - 省掉一次 LLM 往返（对于需要计划的任务，从 2 次调用减为 1 次）
 *   - 对于简单任务，LLM 直接返回 needsPlan=false，不浪费 token 生成计划
 *
 * LLM 输出格式：
 *   简单任务: {"needsPlan": false, "reason": "简短理由"}
 *   复杂任务: {"needsPlan": true, "reason": "简短理由", "plan": [{"title": "...", "description": "..."}]}
 */
export async function assessAndPlan(
  userMessage: string,
  llm: ReActLLMConfig,
  callbacks?: PlanStreamCallbacks,
): Promise<AssessAndPlanResult> {
  const systemPrompt = `你是一个任务规划专家。根据用户的任务描述，你需要：
1. 判断任务是否需要先进行详细规划
2. 如果需要规划，将任务分解为可执行的步骤

【判断标准】
需要规划的任务：涉及多个步骤或阶段、需要操作多个文件或系统、有复杂依赖关系、需要多轮决策
不需要规划的任务：单一明确的操作、简单的信息查询、直接的工具调用

【输出格式 — 严格遵守】
你必须且只能输出一个 JSON 对象，不要输出任何其他内容。

简单任务（不需要规划）：
{"needsPlan": false, "reason": "简短理由"}

复杂任务（需要规划）：
{"needsPlan": true, "reason": "简短理由", "plan": [{"title": "步骤标题", "description": "步骤详细描述"}, ...]}

【计划要求】
- 分解为 3~10 个可执行步骤
- 每个步骤清晰、具体、可验证
- 步骤之间有明确的顺序和依赖关系
- 计划完整覆盖任务的所有方面
- 禁止调用任何工具，禁止执行任何命令
- 禁止使用 markdown 代码块包裹输出`

  const messages: ChatMessage[] = [
    { role: 'user', content: userMessage },
  ]

  const params: LLMRequestParams = {
    baseUrl: llm.baseUrl,
    apiKey: llm.apiKey,
    format: llm.format,
    model: llm.model,
    messages,
    systemPrompt,
    temperature: 0.3,
    maxTokens: 2000,
  }

  try {
    const rawText = await streamAndWait(params, callbacks)
    console.log('[PlanAgent] assessAndPlan LLM 响应 (前500字符):', rawText.substring(0, 500))

    const cleaned = cleanLLMResponse(rawText.trim())
    const jsonStr = extractJsonObject(cleaned)

    if (jsonStr) {
      const parsed = JSON.parse(jsonStr)
      const needsPlan = Boolean(parsed.needsPlan)
      const reason = parsed.reason || '评估完成'

      if (!needsPlan) {
        return { needsPlan: false, reason, planItems: [] }
      }

      // 解析 plan 数组
      const rawPlan = parsed.plan
      if (Array.isArray(rawPlan) && rawPlan.length > 0) {
        const planItems: PlanItem[] = []
        const timestamp = Date.now()
        for (let i = 0; i < rawPlan.length; i++) {
          const item = rawPlan[i]
          if (!item || typeof item !== 'object' || !item.title) {
            console.warn(`[PlanAgent] 跳过无效步骤 #${i}:`, JSON.stringify(item))
            continue
          }
          planItems.push({
            id: `plan-${timestamp}-${planItems.length}`,
            title: String(item.title).trim(),
            description: item.description ? String(item.description).trim() : undefined,
            status: 'pending' as const,
            order: planItems.length,
          })
        }

        if (planItems.length > 0) {
          console.log('[PlanAgent] assessAndPlan 成功:', planItems.map(p => p.title).join(' | '))
          return { needsPlan: true, reason, planItems }
        }
      }

      // plan 数组无效，但标记了 needsPlan=true
      console.warn('[PlanAgent] needsPlan=true 但 plan 数组无效，回退到纯 ReAct')
      return { needsPlan: false, reason: `${reason}（计划生成失败）`, planItems: [] }
    }

    // JSON 提取失败，用关键词回退
    const lowerText = rawText.toLowerCase()
    const guessedNeedsPlan = lowerText.includes('needsplan') || lowerText.includes('需要规划')
    return { needsPlan: guessedNeedsPlan, reason: '从响应文本推断', planItems: [] }
  } catch (err) {
    console.warn('[PlanAgent] assessAndPlan 失败:', err)
    return {
      needsPlan: false,
      reason: `评估失败: ${err instanceof Error ? err.message : String(err)}`,
      planItems: [],
    }
  }
}

