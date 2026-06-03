<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useAgentStore } from '../../stores/agentStore'
import { PROVIDER_CONFIGS, type ApiFormat } from '../../agent/llm/providerConfigs'
import { fetchProviderModels, type ModelInfo } from '../../agent/llm/modelFetcher'
import { checkProviderHealth } from '../../agent/llm/healthCheck'

const props = withDefaults(defineProps<{
  show?: boolean
}>(), {
  show: true,
})

const emit = defineEmits<{
  close: []
}>()

const store = useAgentStore()

const CUSTOM_PROVIDER_CONFIGS: Record<string, { name: string; baseUrl: string; format: ApiFormat; models: { id: string; label: string }[] }> = {
  'custom-openai': {
    name: '自定义 OpenAI 兼容',
    baseUrl: '',
    format: 'openai-compatible',
    models: [],
  },
  'custom-anthropic': {
    name: '自定义 Anthropic',
    baseUrl: '',
    format: 'anthropic',
    models: [],
  },
}

const providerGroups = [
  {
    label: '云端服务',
    providers: [
      { key: 'openai', name: 'OpenAI' },
      { key: 'anthropic', name: 'Anthropic' },
      { key: 'deepseek', name: 'DeepSeek' },
      { key: 'moonshot', name: '月之暗面' },
      { key: 'zhipu', name: '智谱 AI' },
      { key: 'qwen', name: '通义千问' },
      { key: 'minimax', name: 'MiniMax' },
      { key: 'siliconflow', name: '硅基流动' },
      { key: 'openrouter', name: 'OpenRouter' },
    ],
  },
  {
    label: '本地模型',
    providers: [
      { key: 'ollama', name: 'Ollama' },
      { key: 'lmstudio', name: 'LM Studio' },
    ],
  },
  {
    label: '自定义',
    providers: [
      { key: 'custom-openai', name: '自定义 OpenAI 兼容' },
      { key: 'custom-anthropic', name: '自定义 Anthropic' },
    ],
  },
]

const serviceName = ref('')
const selectedProviderKey = ref('')
const apiKey = ref('')
const showApiKey = ref(false)
const baseUrl = ref('')
const fetchedModels = ref<ModelInfo[]>([])
const selectedModelIds = ref<string[]>([])
const manualModelInput = ref('')
const manualModels = ref<{ id: string; label: string }[]>([])
const isFetchingModels = ref(false)
const fetchModelsError = ref('')
const isChecking = ref(false)
const checkResult = ref<{ success: boolean; error?: string; latencyMs?: number } | null>(null)

const currentConfig = computed(() => {
  if (!selectedProviderKey.value) return null
  return PROVIDER_CONFIGS[selectedProviderKey.value] || CUSTOM_PROVIDER_CONFIGS[selectedProviderKey.value] || null
})

const allModels = computed(() => {
  const config = currentConfig.value
  const builtinModels = config?.models || []
  const fetched = fetchedModels.value.filter(m => !builtinModels.some(b => b.id === m.id))
  const manual = manualModels.value
  const combined = [...builtinModels, ...fetched, ...manual]
  const seen = new Set<string>()
  return combined.filter(m => {
    if (seen.has(m.id)) return false
    seen.add(m.id)
    return true
  })
})

function getProviderConfig(key: string) {
  return PROVIDER_CONFIGS[key] || CUSTOM_PROVIDER_CONFIGS[key] || null
}

function selectProvider(key: string) {
  selectedProviderKey.value = key
  const config = getProviderConfig(key)
  if (config) {
    baseUrl.value = config.baseUrl
    if (serviceName.value === '') {
      serviceName.value = config.name
    }
  }
  fetchedModels.value = []
  selectedModelIds.value = []
  fetchModelsError.value = ''
  checkResult.value = null
}

// 本地模型供应商（Ollama / LM Studio）不需要 API Key
const isLocalProvider = computed(() => {
  return ['ollama', 'lmstudio'].includes(selectedProviderKey.value)
})

const canFetchModels = computed(() => !!baseUrl.value.trim() && !!currentConfig.value)
const canValidate = computed(() => {
  if (!baseUrl.value.trim() || !currentConfig.value) return false
  if (isLocalProvider.value) return true // 本地模型不需要 API Key
  return !!apiKey.value.trim()
})

async function handleFetchModels() {
  if (isFetchingModels.value) return
  const config = currentConfig.value
  if (!config) return
  isFetchingModels.value = true
  fetchModelsError.value = ''
  try {
    const result = await fetchProviderModels(baseUrl.value, apiKey.value, config.format)
    if (result.success) {
      fetchedModels.value = result.models
    } else {
      fetchModelsError.value = result.error || '获取模型列表失败'
    }
  } catch (e: any) {
    fetchModelsError.value = e.message || '获取模型列表失败'
  } finally {
    isFetchingModels.value = false
  }
}

function toggleModel(modelId: string) {
  const idx = selectedModelIds.value.indexOf(modelId)
  if (idx >= 0) {
    selectedModelIds.value.splice(idx, 1)
  } else {
    selectedModelIds.value.push(modelId)
  }
}

function addManualModel() {
  const val = manualModelInput.value.trim()
  if (!val) return
  const id = val
  const label = val
  if (!manualModels.value.some(m => m.id === id)) {
    manualModels.value.push({ id, label })
  }
  manualModelInput.value = ''
}

function removeManualModel(id: string) {
  manualModels.value = manualModels.value.filter(m => m.id !== id)
}

async function handleValidate() {
  if (isChecking.value) return
  const config = currentConfig.value
  if (!config) return
  isChecking.value = true
  checkResult.value = null
  try {
    const modelId = selectedModelIds.value[0] || allModels.value[0]?.id
    const result = await checkProviderHealth(baseUrl.value, apiKey.value, config.format, modelId)
    checkResult.value = result
  } catch (e: any) {
    checkResult.value = { success: false, error: e.message || '检查失败' }
  } finally {
    isChecking.value = false
  }
}

const canSave = computed(() => {
  const base = !!serviceName.value.trim()
    && !!selectedProviderKey.value
    && !!baseUrl.value.trim()
    && selectedModelIds.value.length > 0
    && !!currentConfig.value
  if (isLocalProvider.value) return base // 本地模型不需要 API Key
  return base && !!apiKey.value.trim()
})

function handleSave() {
  const config = currentConfig.value
  if (!config) return
  const finalModels = allModels.value.filter(m => selectedModelIds.value.includes(m.id))
  const source: 'builtin' | 'custom' = selectedProviderKey.value.startsWith('custom-') ? 'custom' : 'builtin'
  store.addProvider({
    source,
    name: serviceName.value || config.name,
    enabled: true,
    apiFormat: config.format,
    baseUrl: baseUrl.value,
    apiKey: apiKey.value,
    models: finalModels,
    userAdded: true,
  })
  emit('close')
}

function resetForm() {
  serviceName.value = ''
  selectedProviderKey.value = ''
  apiKey.value = ''
  showApiKey.value = false
  baseUrl.value = ''
  fetchedModels.value = []
  selectedModelIds.value = []
  manualModelInput.value = ''
  manualModels.value = []
  isFetchingModels.value = false
  fetchModelsError.value = ''
  isChecking.value = false
  checkResult.value = null
}

watch(() => props.show, (val) => {
  if (val) {
    resetForm()
  }
})
</script>

<template>
  <Transition name="fade">
    <div v-if="show" class="dialog-mask" @click.self="emit('close')">
      <div class="dialog-card large">
        <div class="dialog-header">
          <h3>添加 LLM 服务商</h3>
          <button class="dialog-close" @click="emit('close')">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>

        <div class="dialog-body">
          <div class="form-group">
            <label>服务名称</label>
            <input
              v-model="serviceName"
              class="form-input"
              placeholder="自定义名称，如：我的 OpenAI"
            />
          </div>

          <div class="form-group">
            <label>服务商</label>
            <select v-model="selectedProviderKey" class="form-select" @change="selectProvider(($event.target as HTMLSelectElement).value)">
              <option value="" disabled>请选择服务商</option>
              <optgroup v-for="group in providerGroups" :key="group.label" :label="group.label">
                <option v-for="p in group.providers" :key="p.key" :value="p.key">
                  {{ p.name }}
                </option>
              </optgroup>
            </select>
          </div>

          <div class="form-group">
            <label>API Key</label>
            <div class="input-with-action">
              <input
                :type="showApiKey ? 'text' : 'password'"
                v-model="apiKey"
                class="form-input"
                placeholder="输入 API Key"
              />
              <button class="input-action-btn" @click="showApiKey = !showApiKey">
                <i :class="showApiKey ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye'"></i>
              </button>
            </div>
          </div>

          <div class="form-group">
            <label>Base URL</label>
            <input v-model="baseUrl" class="form-input" placeholder="https://api.openai.com" />
          </div>

          <div class="form-group">
            <label>模型选择</label>

            <div class="model-actions-row">
              <button
                class="action-btn small"
                :disabled="!canFetchModels || isFetchingModels"
                @click="handleFetchModels"
              >
                <i :class="isFetchingModels ? 'fa-solid fa-spinner fa-spin' : 'fa-solid fa-cloud-arrow-down'"></i>
                获取模型列表
              </button>
              <span v-if="fetchModelsError" class="fetch-error">{{ fetchModelsError }}</span>
            </div>

            <div v-if="allModels.length > 0" class="model-select-list">
              <label
                v-for="m in allModels"
                :key="m.id"
                class="model-select-item"
                :class="{ checked: selectedModelIds.includes(m.id) }"
              >
                <input
                  type="checkbox"
                  :checked="selectedModelIds.includes(m.id)"
                  @change="toggleModel(m.id)"
                />
                <span class="model-select-label">{{ m.label }}</span>
              </label>
            </div>

            <div v-if="allModels.length === 0 && selectedProviderKey" class="model-empty-hint">
              暂无模型，请获取模型列表或手动添加
            </div>

            <div class="model-add-row">
              <input
                v-model="manualModelInput"
                class="form-input model-add-input"
                placeholder="手动输入模型 ID 添加"
                @keyup.enter="addManualModel"
              />
              <button class="action-btn small" @click="addManualModel">
                <i class="fa-solid fa-plus"></i>
              </button>
            </div>

            <div v-if="manualModels.length > 0" class="manual-model-list">
              <div v-for="m in manualModels" :key="m.id" class="manual-model-item">
                <span class="manual-model-label">{{ m.label }}</span>
                <button class="model-remove-btn" @click="removeManualModel(m.id)">
                  <i class="fa-solid fa-xmark"></i>
                </button>
              </div>
            </div>
          </div>

          <div class="validate-section">
            <button
              class="action-btn"
              :disabled="!canValidate || isChecking"
              @click="handleValidate"
            >
              <i :class="isChecking ? 'fa-solid fa-spinner fa-spin' : 'fa-solid fa-rotate'"></i>
              验证连接
            </button>
            <span v-if="checkResult" class="validate-result" :class="{ success: checkResult.success, failed: !checkResult.success }">
              <template v-if="checkResult.success">
                <i class="fa-solid fa-circle-check"></i>
                验证通过
                <span v-if="checkResult.latencyMs" class="validate-latency">{{ checkResult.latencyMs }}ms</span>
              </template>
              <template v-else>
                <i class="fa-solid fa-xmark"></i>
                {{ checkResult.error || '验证失败' }}
              </template>
            </span>
          </div>
        </div>

        <div class="dialog-footer">
          <button class="action-btn" @click="emit('close')">取消</button>
          <button class="action-btn primary" :disabled="!canSave" @click="handleSave">保存</button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.dialog-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.dialog-card {
  background: #FFF;
  border-radius: 16px;
  width: 520px;
  max-height: 85vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.12);
}

.dialog-card.large {
  width: 580px;
}

.dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 24px 0;
}

.dialog-header h3 {
  font-size: 18px;
  font-weight: 600;
  color: #1A1A1A;
  margin: 0;
}

.dialog-close {
  width: 32px;
  height: 32px;
  border: none;
  background: transparent;
  border-radius: 8px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #999;
  font-size: 16px;
  transition: all 0.12s;
}

.dialog-close:hover {
  background: #F0F0F0;
  color: #333;
}

.dialog-body {
  padding: 20px 24px;
  overflow-y: auto;
  flex: 1;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 16px 24px;
  border-top: 1px solid #F0F0F0;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.form-group {
  margin-bottom: 16px;
}

.form-group label {
  display: block;
  font-size: 13px;
  font-weight: 500;
  color: #555;
  margin-bottom: 6px;
}

.form-input,
.form-select {
  width: 100%;
  padding: 10px 14px;
  border: 1px solid #E8E8E8;
  border-radius: 8px;
  font-size: 14px;
  color: #1A1A1A;
  background: #FFF;
  outline: none;
  transition: border-color 0.15s;
  box-sizing: border-box;
}

.form-input:focus,
.form-select:focus {
  border-color: #4285F4;
}

.input-with-action {
  display: flex;
  gap: 8px;
}

.input-with-action .form-input {
  flex: 1;
}

.input-action-btn {
  width: 38px;
  height: 38px;
  border: 1px solid #E8E8E8;
  border-radius: 8px;
  background: #FFF;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #999;
  transition: all 0.12s;
  flex-shrink: 0;
}

.input-action-btn:hover {
  border-color: #999;
  color: #555;
}

.action-btn {
  padding: 8px 16px;
  border: 1px solid #E8E8E8;
  border-radius: 8px;
  background: #FFF;
  font-size: 13px;
  color: #555;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  transition: all 0.12s;
}

.action-btn:hover {
  border-color: #CCC;
}

.action-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.action-btn.primary {
  background: #1A1A1A;
  color: #FFF;
  border-color: #1A1A1A;
}

.action-btn.primary:hover {
  background: #333;
}

.action-btn.primary:disabled {
  background: #999;
  border-color: #999;
  opacity: 1;
}

.action-btn.small {
  padding: 6px 12px;
  font-size: 12px;
}

.model-actions-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}

.fetch-error {
  font-size: 12px;
  color: #ef4444;
}

.model-select-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 180px;
  overflow-y: auto;
  margin-bottom: 10px;
  border: 1px solid #EAEAEA;
  border-radius: 8px;
  padding: 4px;
}

.model-select-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.1s;
  font-size: 13px;
  color: #555;
}

.model-select-item:hover {
  background: #F5F5F5;
}

.model-select-item.checked {
  background: #F0F0F0;
  color: #1A1A1A;
}

.model-select-item input[type="checkbox"] {
  margin: 0;
  accent-color: #1A1A1A;
  flex-shrink: 0;
}

.model-select-label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-empty-hint {
  font-size: 12px;
  color: #CCC;
  text-align: center;
  padding: 16px 0;
}

.model-add-row {
  display: flex;
  gap: 8px;
  align-items: center;
}

.model-add-input {
  flex: 1;
}

.manual-model-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.manual-model-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  background: #F3F3F3;
  border-radius: 6px;
  font-size: 12px;
  color: #555;
}

.manual-model-label {
  color: #1A1A1A;
}

.model-remove-btn {
  width: 18px;
  height: 18px;
  border: none;
  background: transparent;
  border-radius: 50%;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #999;
  font-size: 10px;
  transition: all 0.12s;
  padding: 0;
}

.model-remove-btn:hover {
  background: #EAEAEA;
  color: #ef4444;
}

.validate-section {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-top: 4px;
}

.validate-result {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  font-weight: 500;
}

.validate-result.success {
  color: #10b981;
}

.validate-result.failed {
  color: #ef4444;
}

.validate-latency {
  font-size: 11px;
  color: #999;
  margin-left: 2px;
}
</style>
