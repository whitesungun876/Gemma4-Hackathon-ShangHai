/**
 * 统一的 LLM 客户端 — 封装不同供应商（OpenAI 兼容 vs Anthropic）的差异。
 *
 * 使用方式：
 *   import { chat, streamChat } from '@/agent/llm/llmClient'
 *
 *   // 非流式
 *   const text = await chat({ baseUrl, apiKey, format, model, messages })
 *
 *   // 流式
 *   const ctrl = streamChat({ baseUrl, apiKey, format, model, messages }, {
 *     onToken(t) { ... },
 *     onThinking(t) { ... },
 *     onToolCall(tc) { ... },
 *     onComplete(fullText) { ... },
 *     onError(err) { ... },
 *   })
 *   ctrl.abort() // 随时取消
 */

import type { ApiFormat } from './providerConfigs'
import { buildFullChatUrl } from './urlUtils'

// ─── 公共类型 ────────────────────────────────────────────

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool'

export interface ChatMessage {
  role: MessageRole
  content: string
  /** 当 role 为 'tool' 时必须 — 对应工具调用的 ID */
  tool_call_id?: string
  /** 存在于请求工具调用的 assistant 消息上 */
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  /** DeepSeek 思考模式：reasoning_content 必须在后续请求中回传 */
  reasoning_content?: string
}

/** 传递给模型的工具定义（OpenAI function-calling 格式） */
export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

/** 模型在流式响应中返回的工具调用 */
export interface ToolCall {
  /** 模型分配的唯一 ID（存在于非流式响应中） */
  id?: string
  /** 流式响应中的工具调用索引（多工具场景下用于匹配） */
  index?: number
  name: string
  arguments: string
}

/**
 * chat 和 streamChat 共享的参数。
 * 调用者只需填写这些 — 供应商差异由内部处理。
 */
export interface LLMRequestParams {
  /** 供应商 API 基础 URL，如 "https://api.openai.com" */
  baseUrl: string
  /** API 密钥或令牌 */
  apiKey: string
  /** API 格式："openai-compatible" | "anthropic" */
  format: ApiFormat
  /** 模型标识符，如 "gpt-4o"、"claude-sonnet-4-20250514" */
  model: string
  /** 对话消息 */
  messages: ChatMessage[]
  /** 可选的系统提示（OpenAI 时前置，Anthropic 时放入 body.system） */
  systemPrompt?: string
  /** 采样温度（0 – 2），默认 0.7 */
  temperature?: number
  /** 最大输出 token 数，默认 4096 */
  maxTokens?: number
  /** function-calling 的工具定义 */
  tools?: ToolDefinition[]
}

/** 流式响应的回调函数 */
export interface StreamCallbacks {
  /** 每个文本 token 触发 */
  onToken: (token: string) => void
  /** 思考/推理 token 触发（DeepSeek-R1、Claude 扩展思考） */
  onThinking?: (thinking: string) => void
  /** 模型发出工具调用时触发 */
  onToolCall?: (toolCall: ToolCall) => void
  /** 流结束并返回完整累积文本时触发 */
  onComplete: (fullText: string, reasoningContent?: string) => void
  /** 网络或解析错误时触发 */
  onError: (error: Error) => void
}

/** streamChat 返回的句柄，用于中止控制 */
export interface StreamHandle {
  /** 中止正在进行的请求 */
  abort: () => void
}

/** chatRaw() 返回的完整响应，包含文本和工具调用 */
export interface RawChatResponse {
  /** 助手文本内容（有工具调用时可能为空） */
  text: string
  /** 模型请求的工具调用 */
  toolCalls: ToolCall[]
  /** 模型是否请求进一步工具调用（finish_reason = 'tool_calls'） */
  finishReason: 'stop' | 'tool_calls' | 'length' | 'error'
  /** DeepSeek 思考模式：reasoning_content（需回传给 API） */
  reasoningContent?: string
}

// ─── 非流式调用 ──────────────────────────────────────

/**
 * 发送单个请求并返回完整响应文本。
 * HTTP 或网络错误时抛出异常。
 */
export async function chat(params: LLMRequestParams): Promise<string> {
  if (params.format === 'anthropic') {
    return chatAnthropic(params)
  }
  return chatOpenAI(params)
}

/**
 * 发送单个请求并返回完整的结构化响应，
 * 包含文本内容和任何工具调用。
 * HTTP 或网络错误时抛出异常。
 */
export async function chatRaw(params: LLMRequestParams): Promise<RawChatResponse> {
  if (params.format === 'anthropic') {
    return chatRawAnthropic(params)
  }
  return chatRawOpenAI(params)
}

// ─── 流式调用 ──────────────────────────────────────────

/**
 * 发送流式请求。token 到达时触发回调。
 * 返回 `StreamHandle`，其 `abort()` 方法可取消请求。
 */
export function streamChat(
  params: LLMRequestParams,
  callbacks: StreamCallbacks,
): StreamHandle {
  const controller = new AbortController()

  // 触发异步工作
  if (params.format === 'anthropic') {
    streamAnthropic(params, callbacks, controller.signal)
  } else {
    streamOpenAI(params, callbacks, controller.signal)
  }

  return { abort: () => controller.abort() }
}

// ─── OpenAI 兼容内部实现 ─────────────────────────────

async function chatOpenAI(params: LLMRequestParams): Promise<string> {
  const url = buildFullChatUrl(params.baseUrl, 'openai-compatible')
  const body = buildOpenAIBody(params, false)

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: openAIHeaders(params.apiKey),
      body: JSON.stringify(body),
    })
  } catch (err) {
    throw normalizeError(err)
  }

  if (!res.ok) {
    throw new Error(await formatApiError(res, 'OpenAI-compatible'))
  }

  const json = await res.json()
  return json.choices?.[0]?.message?.content || ''
}

async function chatRawOpenAI(params: LLMRequestParams): Promise<RawChatResponse> {
  const url = buildFullChatUrl(params.baseUrl, 'openai-compatible')
  const body = buildOpenAIBody(params, false)

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: openAIHeaders(params.apiKey),
      body: JSON.stringify(body),
    })
  } catch (err) {
    throw normalizeError(err)
  }

  if (!res.ok) {
    throw new Error(await formatApiError(res, 'OpenAI-compatible'))
  }

  const json = await res.json()
  const choice = json.choices?.[0]
  const msg = choice?.message

  const toolCalls: ToolCall[] = (msg?.tool_calls || []).map((tc: any) => ({
    id: tc.id || '',
    name: tc.function?.name || '',
    arguments: tc.function?.arguments || '',
  }))

  const finishReason =
    choice?.finish_reason === 'tool_calls' ? 'tool_calls' :
    choice?.finish_reason === 'length' ? 'length' : 'stop'

  return {
    text: msg?.content || '',
    toolCalls,
    finishReason,
    // Ollama Gemma 4 使用 msg.reasoning，DeepSeek 使用 msg.reasoning_content
    reasoningContent: msg?.reasoning_content || msg?.reasoning || undefined,
  }
}

async function streamOpenAI(
  params: LLMRequestParams,
  callbacks: StreamCallbacks,
  signal: AbortSignal,
): Promise<void> {
  const url = buildFullChatUrl(params.baseUrl, 'openai-compatible')
  const body = buildOpenAIBody(params, true)

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: openAIHeaders(params.apiKey),
      body: JSON.stringify(body),
      signal,
    })

    if (!res.ok) {
      throw new Error(await formatApiError(res, 'OpenAI-compatible'))
    }

    const reader = res.body?.getReader()
    if (!reader) throw new Error('No response body')

    const decoder = new TextDecoder()
    let fullText = ''
    let fullReasoning = ''
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()

        if (data === '[DONE]') {
          callbacks.onComplete(fullText, fullReasoning || undefined)
          return
        }

        try {
          const json = JSON.parse(data)
          const choice = json.choices?.[0]
          // 流式响应用 delta，非流式响应（部分 Ollama 版本即使 stream=true 也返回非流式格式）用 message
          const delta = choice?.delta || choice?.message

          // 常规内容 token
          if (delta?.content) {
            fullText += delta.content
            callbacks.onToken(delta.content)
          }

          // 工具调用（function-calling）— 保留 index 用于多工具匹配
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              if (tc.function) {
                callbacks.onToolCall?.({
                  index: tc.index ?? 0,
                  id: tc.id || '',
                  name: tc.function.name || '',
                  arguments: tc.function.arguments || '',
                })
              }
            }
          }

          // 思考字段兼容：
          // - DeepSeek → delta.reasoning_content
          // - Ollama Gemma 4 → delta.reasoning
          const thinkingToken = delta?.reasoning_content || delta?.reasoning
          if (thinkingToken) {
            fullReasoning += thinkingToken
            callbacks.onThinking?.(thinkingToken)
          }
        } catch {
          // 忽略 SSE 行中的 JSON 解析错误
        }
      }
    }

    // 处理流结束后缓冲区中的剩余数据（部分供应商不发送 [DONE] 且最后一条 data 行无换行符）
    if (buffer.trim()) {
      const remainingLine = buffer.trim()
      if (remainingLine.startsWith('data: ')) {
        const data = remainingLine.slice(6).trim()
        if (data !== '[DONE]') {
          try {
            const json = JSON.parse(data)
            const choice = json.choices?.[0]
            const delta = choice?.delta || choice?.message
            if (delta?.content) {
              fullText += delta.content
              callbacks.onToken(delta.content)
            }
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                if (tc.function) {
                  callbacks.onToolCall?.({
                    index: tc.index ?? 0,
                    id: tc.id || '',
                    name: tc.function.name || '',
                    arguments: tc.function.arguments || '',
                  })
                }
              }
            }
            const thinkingToken = delta?.reasoning_content || delta?.reasoning
            if (thinkingToken) {
              fullReasoning += thinkingToken
              callbacks.onThinking?.(thinkingToken)
            }
          } catch {
            // 忽略解析错误
          }
        }
      }
    }

    // 流结束但没有 [DONE] 标记
    callbacks.onComplete(fullText, fullReasoning || undefined)
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') return
    callbacks.onError(normalizeError(err))
  }
}

// ─── Anthropic 内部实现 ─────────────────────────────────────

async function chatAnthropic(params: LLMRequestParams): Promise<string> {
  const url = buildFullChatUrl(params.baseUrl, 'anthropic')
  const body = buildAnthropicBody(params, false)

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: anthropicHeaders(params.apiKey),
      body: JSON.stringify(body),
    })
  } catch (err) {
    throw normalizeError(err)
  }

  if (!res.ok) {
    throw new Error(await formatApiError(res, 'Anthropic'))
  }

  const json = await res.json()
  return json.content?.[0]?.text || ''
}

async function chatRawAnthropic(params: LLMRequestParams): Promise<RawChatResponse> {
  const url = buildFullChatUrl(params.baseUrl, 'anthropic')
  const body = buildAnthropicBody(params, false)

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: anthropicHeaders(params.apiKey),
      body: JSON.stringify(body),
    })
  } catch (err) {
    throw normalizeError(err)
  }

  if (!res.ok) {
    throw new Error(await formatApiError(res, 'Anthropic'))
  }

  const json = await res.json()
  const content = json.content || []

  // Anthropic 将 tool_use 作为与文本并列的内容块返回
  const textBlocks = content.filter((b: any) => b.type === 'text')
  const toolUseBlocks = content.filter((b: any) => b.type === 'tool_use')

  const toolCalls: ToolCall[] = toolUseBlocks.map((tc: any) => ({
    id: tc.id || '',
    name: tc.name || '',
    arguments: JSON.stringify(tc.input || {}),
  }))

  const finishReason =
    json.stop_reason === 'tool_use' ? 'tool_calls' :
    json.stop_reason === 'max_tokens' ? 'length' : 'stop'

  return {
    text: textBlocks.map((b: any) => b.text).join(''),
    toolCalls,
    finishReason,
  }
}

async function streamAnthropic(
  params: LLMRequestParams,
  callbacks: StreamCallbacks,
  signal: AbortSignal,
): Promise<void> {
  const url = buildFullChatUrl(params.baseUrl, 'anthropic')
  const body = buildAnthropicBody(params, true)

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: anthropicHeaders(params.apiKey),
      body: JSON.stringify(body),
      signal,
    })

    if (!res.ok) {
      throw new Error(await formatApiError(res, 'Anthropic'))
    }

    const reader = res.body?.getReader()
    if (!reader) throw new Error('No response body')

    const decoder = new TextDecoder()
    let fullText = ''
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()

        try {
          const json = JSON.parse(data)

          if (json.type === 'content_block_delta') {
            if (json.delta?.type === 'text_delta') {
              fullText += json.delta.text
              callbacks.onToken(json.delta.text)
            } else if (json.delta?.type === 'thinking_delta') {
              callbacks.onThinking?.(json.delta.thinking)
            }
          }

          if (json.type === 'message_stop') {
            callbacks.onComplete(fullText)
            return
          }
        } catch {
          // 忽略 SSE 行中的 JSON 解析错误
        }
      }
    }

    callbacks.onComplete(fullText)
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') return
    callbacks.onError(normalizeError(err))
  }
}

// ─── 请求体构建器 ───────────────────────────────────

function buildOpenAIBody(params: LLMRequestParams, stream: boolean): Record<string, unknown> {
  // 构建请求消息，保留 reasoning_content 用于 DeepSeek 思考模式回传
  const requestMessages: ChatMessage[] = params.messages.map(m => {
    const msg: ChatMessage = { role: m.role, content: m.content }
    if (m.tool_call_id) msg.tool_call_id = m.tool_call_id
    if (m.tool_calls) msg.tool_calls = m.tool_calls
    if (m.reasoning_content) msg.reasoning_content = m.reasoning_content
    return msg
  })

  const allMessages: ChatMessage[] = params.systemPrompt
    ? [{ role: 'system', content: params.systemPrompt }, ...requestMessages]
    : requestMessages

  const body: Record<string, unknown> = {
    model: params.model,
    messages: allMessages,
    stream,
    temperature: params.temperature ?? 0.7,
    max_tokens: params.maxTokens ?? 16384,
  }

  if (params.tools && params.tools.length > 0) {
    body.tools = params.tools
  }

  return body
}

function buildAnthropicBody(params: LLMRequestParams, stream: boolean): Record<string, unknown> {
  // Anthropic 将系统提示与消息分开
  const messages = params.messages
    .filter(m => m.role !== 'system')
    .map(m => ({ role: m.role, content: m.content }))

  const body: Record<string, unknown> = {
    model: params.model,
    messages,
    max_tokens: params.maxTokens ?? 16384,
    stream,
  }

  if (params.systemPrompt) {
    body.system = params.systemPrompt
  }

  if (params.tools && params.tools.length > 0) {
    // 将 OpenAI 风格的工具转换为 Anthropic 格式
    body.tools = params.tools.map(t => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters,
    }))
  }

  return body
}

// ─── 请求头构建器 ─────────────────────────────────────────

function openAIHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
  return headers
}

function anthropicHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  }
}

// ─── 错误处理辅助函数 ───────────────────────────────────────────

async function formatApiError(res: Response, provider: string): Promise<string> {
  const text = await res.text().catch(() => '')

  // 标准 HTTP 状态码快捷方式
  if (res.status === 401) return `${provider}: API key invalid or expired`
  if (res.status === 403) return `${provider}: Access forbidden`
  if (res.status === 429) return `${provider}: Rate limit exceeded`
  if (res.status === 503) return `${provider}: Service temporarily unavailable`

  // 尝试从 JSON body 中提取错误消息
  try {
    const json = JSON.parse(text)
    const msg = json.error?.message || json.message || text.slice(0, 200)
    return `${provider} (${res.status}): ${msg}`
  } catch {
    return `${provider} (${res.status}): ${text.slice(0, 200)}`
  }
}

function normalizeError(err: unknown): Error {
  if (err instanceof Error) {
    // 用更友好的消息包装常见网络错误
    if (
      err.message.includes('fetch') ||
      err.message.includes('network') ||
      err.message.includes('Failed to fetch')
    ) {
      return new Error('Network connection failed, please check your API address')
    }
    return err
  }
  return new Error(String(err))
}
