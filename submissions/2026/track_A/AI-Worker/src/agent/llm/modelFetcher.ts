import type { ApiFormat } from './providerConfigs'

export interface ModelInfo {
  id: string
  label: string
  /** 模型上下文窗口大小（token 数），如果 API 返回了该字段 */
  contextWindow?: number
}

interface FetchModelsResult {
  success: boolean
  models: ModelInfo[]
  error?: string
}

/** 已知的模型上下文窗口映射（用于 API 不返回 context_window 的情况） */
const KNOWN_CONTEXT_WINDOWS: Record<string, number> = {
  'gpt-4o': 128000,
  'gpt-4o-mini': 128000,
  'gpt-3.5-turbo': 16385,
  'o3-mini': 200000,
  'deepseek-chat': 64000,
  'deepseek-reasoner': 64000,
  'qwen-max': 32000,
  'qwen-plus': 131072,
  'qwen-turbo': 131072,
  'glm-4-flash': 128000,
  'glm-4-plus': 128000,
  'glm-4-air': 128000,
  'glm-4-long': 1000000,
}

/** 判断是否为 Ollama 本地服务地址 */
function isOllamaBaseUrl(baseUrl: string): boolean {
  const normalized = baseUrl.trim().replace(/\/+$/, '')
  return normalized.endsWith(':11434') || normalized.includes('localhost:11434') || normalized.includes('127.0.0.1:11434')
}

export async function fetchProviderModels(
  baseUrl: string,
  apiKey: string,
  format: ApiFormat,
): Promise<FetchModelsResult> {
  if (!baseUrl.trim()) {
    return { success: false, models: [], error: '未填写 API 地址' }
  }

  if (format === 'anthropic') {
    return { success: false, models: [], error: 'Anthropic API 不支持获取模型列表' }
  }

  const normalizedBase = baseUrl.trim().replace(/\/+$/, '')

  // 优先尝试 OpenAI 兼容的 /v1/models 端点
  const openAIResult = await fetchOpenAIModels(normalizedBase, apiKey)
  if (openAIResult.success && openAIResult.models.length > 0) {
    return openAIResult
  }

  // 若 OpenAI 端点失败且看起来是 Ollama 地址，尝试 Ollama 原生 /api/tags 端点
  if (isOllamaBaseUrl(normalizedBase)) {
    const ollamaResult = await fetchOllamaModels(normalizedBase)
    if (ollamaResult.success) return ollamaResult
  }

  // 返回 OpenAI 端点的结果（即使是错误信息，也比 Ollama 回退更准确）
  return openAIResult
}

/** 通过 OpenAI 兼容端点获取模型列表 */
async function fetchOpenAIModels(baseUrl: string, apiKey: string): Promise<FetchModelsResult> {
  try {
    // 确保 URL 包含 /v1 前缀
    const apiUrl = baseUrl.endsWith('/v1')
      ? baseUrl + '/models'
      : baseUrl + '/v1/models'
    const headers: Record<string, string> = {}
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`
    }

    const res = await fetch(apiUrl, { headers })
    if (!res.ok) {
      return { success: false, models: [], error: `HTTP ${res.status}` }
    }

    const data = await res.json()
    const models: ModelInfo[] = (data.data || [])
      .filter((m: any) => {
        const id = (m.id || '').toLowerCase()
        if (id.includes('embedding') || id.includes('whisper')
          || id.includes('tts') || id.includes('dall-e')
          || id.includes('moderation')) {
          return false
        }
        return true
      })
      .map((m: any) => {
        const id = m.id
        const info: ModelInfo = { id, label: id }
        if (typeof m.context_window === 'number' && m.context_window > 0) {
          info.contextWindow = m.context_window
        } else if (KNOWN_CONTEXT_WINDOWS[id]) {
          info.contextWindow = KNOWN_CONTEXT_WINDOWS[id]
        }
        return info
      })

    return { success: true, models }
  } catch (e: any) {
    return { success: false, models: [], error: e.message || '获取失败' }
  }
}

/** 通过 Ollama 原生 /api/tags 端点获取模型列表 */
async function fetchOllamaModels(baseUrl: string): Promise<FetchModelsResult> {
  try {
    const apiUrl = baseUrl + '/api/tags'
    const res = await fetch(apiUrl)
    if (!res.ok) {
      return { success: false, models: [], error: `Ollama HTTP ${res.status}` }
    }

    const data = await res.json()
    // Ollama /api/tags 返回 { models: [{ name: "llama3:latest", ... }] }
    const models: ModelInfo[] = (data.models || [])
      .map((m: any) => {
        const id = m.model || m.name || ''
        const info: ModelInfo = { id, label: id }
        if (KNOWN_CONTEXT_WINDOWS[id]) {
          info.contextWindow = KNOWN_CONTEXT_WINDOWS[id]
        }
        return info
      })
      .filter((m: ModelInfo) => !!m.id)

    return { success: true, models }
  } catch (e: any) {
    return { success: false, models: [], error: e.message || 'Ollama 获取失败' }
  }
}
