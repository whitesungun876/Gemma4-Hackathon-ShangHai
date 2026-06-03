// LLM 服务层 - 支持多模型调用，参考 Abu-Cowork/src/core/llm
import type { LLMConfig, LLMProvider } from '../types/agent'

interface LLMRequestMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface LLMStreamCallbacks {
  onToken: (token: string) => void
  onThinking?: (thinking: string) => void
  onToolCall?: (toolCall: { name: string; arguments: string }) => void
  onComplete: (fullText: string) => void
  onError: (error: Error) => void
}

// 各厂商 API 基地址映射
const PROVIDER_BASE_URLS: Record<LLMProvider, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  deepseek: 'https://api.deepseek.com/v1',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  doubao: 'https://ark.cn-beijing.volces.com/api/v3',
  moonshot: 'https://api.moonshot.cn/v1',
  minimax: 'https://api.minimax.chat/v1',
  ollama: 'http://localhost:11434/v1',
  custom: ''
}

// 工具定义
const AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: '搜索互联网获取最新信息',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取指定文件内容',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '写入文件内容',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径' },
          content: { type: 'string', description: '文件内容' }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: '执行系统命令',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的命令' }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: '列出目录中的文件',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '目录路径' }
        },
        required: ['path']
      }
    }
  }
]

export class LLMService {
  private config: LLMConfig
  private abortController: AbortController | null = null

  constructor(config: LLMConfig) {
    this.config = config
  }

  updateConfig(config: LLMConfig) {
    this.config = config
  }

  getBaseUrl(): string {
    if (this.config.baseUrl) return this.config.baseUrl
    return PROVIDER_BASE_URLS[this.config.provider] || PROVIDER_BASE_URLS.openai
  }

  abort() {
    if (this.abortController) {
      this.abortController.abort()
      this.abortController = null
    }
  }

  // OpenAI 兼容格式的流式请求（适用于 OpenAI, DeepSeek, Qwen, Doubao, Moonshot, MiniMax, Ollama）
  async streamChat(
    messages: LLMRequestMessage[],
    callbacks: LLMStreamCallbacks,
    systemPrompt?: string
  ): Promise<void> {
    this.abortController = new AbortController()

    if (this.config.provider === 'anthropic') {
      return this.streamChatAnthropic(messages, callbacks, systemPrompt)
    }

    const baseUrl = this.getBaseUrl()
    const url = `${baseUrl}/chat/completions`

    const requestMessages = systemPrompt
      ? [{ role: 'system' as const, content: systemPrompt }, ...messages]
      : messages

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: requestMessages,
      stream: true,
      temperature: this.config.temperature,
      max_tokens: this.config.maxOutputTokens,
      tools: AGENT_TOOLS,
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: this.abortController.signal,
      })

      if (!response.ok) {
        const errText = await response.text()
        let errorMsg = `API 请求失败 (${response.status})`
        try {
          const errJson = JSON.parse(errText)
          errorMsg = errJson.error?.message || errJson.message || errorMsg
        } catch {
          if (errText.length < 200) errorMsg += ': ' + errText
        }
        if (response.status === 401) errorMsg = 'API Key 无效或已过期，请检查设置'
        if (response.status === 429) errorMsg = '请求过于频繁，请稍后重试'
        if (response.status === 503) errorMsg = 'AI服务暂时不可用，请稍后重试'
        throw new Error(errorMsg)
      }

      const reader = response.body?.getReader()
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
          if (data === '[DONE]') {
            callbacks.onComplete(fullText)
            return
          }

          try {
            const json = JSON.parse(data)
            const choice = json.choices?.[0]
            // 流式响应用 delta，非流式响应（部分 Ollama 版本即使 stream=true 也返回非流式格式）用 message
            const delta = choice?.delta || choice?.message

            if (delta?.content) {
              fullText += delta.content
              callbacks.onToken(delta.content)
            }

            // 处理 tool calls
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                if (tc.function) {
                  callbacks.onToolCall?.({
                    name: tc.function.name || '',
                    arguments: tc.function.arguments || ''
                  })
                }
              }
            }

            // 思考字段兼容：DeepSeek → reasoning_content, Ollama Gemma 4 → reasoning
            const thinkingToken = delta?.reasoning_content || delta?.reasoning
            if (thinkingToken) {
              callbacks.onThinking?.(thinkingToken)
            }
          } catch {
            // 忽略解析错误
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
                      name: tc.function.name || '',
                      arguments: tc.function.arguments || ''
                    })
                  }
                }
              }
              const thinkingToken = delta?.reasoning_content || delta?.reasoning
              if (thinkingToken) {
                callbacks.onThinking?.(thinkingToken)
              }
            } catch {
              // 忽略解析错误
            }
          }
        }
      }

      callbacks.onComplete(fullText)
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        return
      }
      if (err instanceof TypeError && (err.message.includes('fetch') || err.message.includes('network') || err.message.includes('Failed'))) {
        callbacks.onError(new Error('网络连接失败，请检查网络或 API 地址是否正确'))
        return
      }
      callbacks.onError(err instanceof Error ? err : new Error(String(err)))
    }
  }

  // Anthropic Claude 专用格式
  private async streamChatAnthropic(
    messages: LLMRequestMessage[],
    callbacks: LLMStreamCallbacks,
    systemPrompt?: string
  ): Promise<void> {
    const baseUrl = this.getBaseUrl()
    const url = `${baseUrl}/v1/messages`

    const anthropicMessages = messages
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role, content: m.content }))

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: anthropicMessages,
      max_tokens: this.config.maxOutputTokens,
      stream: true,
    }

    if (systemPrompt) {
      body.system = systemPrompt
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.config.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: this.abortController!.signal,
      })

      if (!response.ok) {
        const errText = await response.text()
        throw new Error(`Claude API Error (${response.status}): ${errText}`)
      }

      const reader = response.body?.getReader()
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
            // 忽略解析错误
          }
        }
      }

      callbacks.onComplete(fullText)
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        return
      }
      callbacks.onError(err instanceof Error ? err : new Error(String(err)))
    }
  }

  // 非流式调用（用于工具执行后的续对话）
  async chat(messages: LLMRequestMessage[], systemPrompt?: string): Promise<string> {
    if (this.config.provider === 'anthropic') {
      return this.chatAnthropic(messages, systemPrompt)
    }

    const baseUrl = this.getBaseUrl()
    const url = `${baseUrl}/chat/completions`

    const requestMessages = systemPrompt
      ? [{ role: 'system' as const, content: systemPrompt }, ...messages]
      : messages

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: requestMessages,
        temperature: this.config.temperature,
        max_tokens: this.config.maxOutputTokens,
      }),
    })

    if (!response.ok) {
      const errText = await response.text()
      throw new Error(`LLM API Error (${response.status}): ${errText}`)
    }

    const json = await response.json()
    return json.choices?.[0]?.message?.content || ''
  }

  private async chatAnthropic(messages: LLMRequestMessage[], systemPrompt?: string): Promise<string> {
    const baseUrl = this.getBaseUrl()
    const url = `${baseUrl}/v1/messages`

    const anthropicMessages = messages
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role, content: m.content }))

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: anthropicMessages,
      max_tokens: this.config.maxOutputTokens,
    }
    if (systemPrompt) body.system = systemPrompt

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const errText = await response.text()
      throw new Error(`Claude API Error (${response.status}): ${errText}`)
    }

    const json = await response.json()
    return json.content?.[0]?.text || ''
  }
}

// 单例服务
let _instance: LLMService | null = null

export function getLLMService(config: LLMConfig): LLMService {
  if (!_instance) {
    _instance = new LLMService(config)
  } else {
    _instance.updateConfig(config)
  }
  return _instance
}
