import React, { useState, useEffect, useCallback, useRef } from 'react'
import {
  ArrowLeft,
  RotateCw,
  Plus,
  MoreHorizontal,
  Check,
  Pencil,
  Trash2,
  Eye,
  EyeOff,
  SlidersHorizontal,
  Palette,
  Box,
  Globe,
  Monitor,
  Brain,
  Bot,
  Puzzle,
  Server,
  Sparkles,
  Terminal,
  Anchor,
  Database,
  BarChart3,
  BookOpen,
  User,
  Settings,
  X,
  ChevronDown,
  Activity,
  Loader2
} from 'lucide-react'
import { ProviderConfig, ModelProvider, ModelItem, ApiFormat, ConnectivityResult } from '@shared/types'
import {
  API_FORMAT_OPTIONS,
  createDefaultProviders,
  findActiveModelAndProvider,
  COMMON_MODEL_TAGS,
  PRESET_PROVIDER_TEMPLATES
} from '@shared/models'

interface ApiFormatDropdownProps {
  value: ApiFormat
  onChange: (val: ApiFormat) => void
  className?: string
}

const ApiFormatDropdown: React.FC<ApiFormatDropdownProps> = ({ value, onChange, className = '' }) => {
  const [isOpen, setIsOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [])

  const currentOption = API_FORMAT_OPTIONS.find((opt) => opt.value === value) || API_FORMAT_OPTIONS[0]

  return (
    <div className={`relative ${className}`} ref={dropdownRef}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full bg-neutral-50 hover:bg-white focus:bg-white border border-neutral-200/90 rounded-xl px-3.5 py-2 text-xs text-neutral-900 flex items-center justify-between cursor-pointer transition-colors shadow-2xs text-left"
      >
        <span className="truncate">{currentOption.label}</span>
        <ChevronDown
          className={`w-3.5 h-3.5 text-neutral-400 transition-transform shrink-0 ml-2 ${
            isOpen ? 'rotate-180 text-neutral-700' : ''
          }`}
        />
      </button>

      {isOpen && (
        <div className="absolute left-0 top-full mt-1.5 w-full bg-white border border-neutral-200/90 rounded-xl shadow-xl z-30 py-1 overflow-hidden animate-in fade-in duration-100 divide-y divide-neutral-100">
          {API_FORMAT_OPTIONS.map((opt) => {
            const isSelected = value === opt.value
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => {
                  onChange(opt.value)
                  setIsOpen(false)
                }}
                className={`w-full text-left px-3.5 py-2.5 text-xs flex items-center justify-between transition-colors ${
                  isSelected
                    ? 'bg-blue-50/70 text-blue-600 font-medium'
                    : 'text-neutral-700 hover:bg-neutral-50'
                }`}
              >
                <span>{opt.label}</span>
                {isSelected && <Check className="w-4 h-4 text-blue-600 shrink-0 ml-2" />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

interface SettingsModalProps {
  isOpen: boolean

  onClose: () => void
  onConfigUpdated?: (config: ProviderConfig) => void
  initialTab?: string
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  onConfigUpdated,
  initialTab = 'model'
}) => {
  const [activeTab, setActiveTab] = useState<string>(initialTab)
  const [config, setConfig] = useState<ProviderConfig>({
    providers: [],
    activeModelId: 'deepseek-chat',
    temperature: 0.2
  })
  const [selectedProviderId, setSelectedProviderId] = useState<string>('')
  const [showApiKey, setShowApiKey] = useState<boolean>(false)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [moreMenuOpen, setMoreMenuOpen] = useState<boolean>(false)

  // Dialog states
  const [isAddProviderOpen, setIsAddProviderOpen] = useState<boolean>(false)
  const [newProviderName, setNewProviderName] = useState<string>('')
  const [newProviderBaseURL, setNewProviderBaseURL] = useState<string>('')
  const [newProviderApiKey, setNewProviderApiKey] = useState<string>('')
  const [newProviderFormat, setNewProviderFormat] = useState<ApiFormat>('anthropic_messages')
  const [selectedTemplateKey, setSelectedTemplateKey] = useState<string>('')

  // Ping / Connectivity test states
  const [testingKey, setTestingKey] = useState<string | null>(null)
  const [testResults, setTestResults] = useState<Record<string, ConnectivityResult>>({})

  // Delete provider confirmation dialog
  const [confirmDeleteProvider, setConfirmDeleteProvider] = useState<boolean>(false)

  const [isModelModalOpen, setIsModelModalOpen] = useState<boolean>(false)
  const [editingModelIndex, setEditingModelIndex] = useState<number | null>(null)
  const [modelModalId, setModelModalId] = useState<string>('')
  const [modelModalName, setModelModalName] = useState<string>('')
  const [modelModalTags, setModelModalTags] = useState<string>('')
  const [modelModalSetActive, setModelModalSetActive] = useState<boolean>(true)

  const [isRenameProviderOpen, setIsRenameProviderOpen] = useState<boolean>(false)
  const [renameValue, setRenameValue] = useState<string>('')

  // Load config on open
  const reloadConfig = useCallback(async () => {
    try {
      const saved = await window.electronAPI?.getProviderConfig?.()
      if (saved) {
        let providers = saved.providers || []
        if (providers.length === 0) {
          providers = createDefaultProviders(saved)
          saved.providers = providers
        }
        setConfig(saved)
        if (saved.activeProviderId && providers.some((p) => p.id === saved.activeProviderId)) {
          setSelectedProviderId(saved.activeProviderId)
        } else if (providers.length > 0) {
          setSelectedProviderId(providers[0].id)
        }
      }
    } catch (e) {
      console.error('Failed to load config:', e)
    }
  }, [])

  useEffect(() => {
    if (isOpen) {
      reloadConfig()
      setActiveTab(initialTab)
    }
  }, [isOpen, initialTab, reloadConfig])

  // Save config helper
  const persistConfig = async (newConfig: ProviderConfig) => {
    setConfig(newConfig)
    setSaveStatus('saving')
    try {
      const ok = await window.electronAPI?.saveProviderConfig?.(newConfig)
      if (ok) {
        setSaveStatus('saved')
        onConfigUpdated?.(newConfig)
        setTimeout(() => setSaveStatus('idle'), 1500)
      }
    } catch (e) {
      console.error('Failed to save config:', e)
      setSaveStatus('idle')
    }
  }

  if (!isOpen) return null

  const providers = config.providers || []
  const selectedProvider = providers.find((p) => p.id === selectedProviderId) || providers[0]

  // Update selected provider
  const updateCurrentProvider = (updater: (p: ModelProvider) => ModelProvider) => {
    if (!selectedProvider) return
    const updatedProviders = providers.map((p) => {
      if (p.id === selectedProvider.id) {
        return updater({ ...p })
      }
      return p
    })
    const newConfig = { ...config, providers: updatedProviders }
    persistConfig(newConfig)
  }

  // Provider Actions
  const handleToggleProviderEnabled = () => {
    if (!selectedProvider) return
    updateCurrentProvider((p) => ({ ...p, enabled: !p.enabled }))
  }

  const handleDeleteProvider = () => {
    if (!selectedProvider) return
    setConfirmDeleteProvider(true)
    setMoreMenuOpen(false)
  }

  const handleDeleteProviderConfirm = () => {
    if (!selectedProvider) return
    const remaining = providers.filter((p) => p.id !== selectedProvider.id)
    const nextSelected = remaining.length > 0 ? remaining[0].id : ''
    setSelectedProviderId(nextSelected)
    const newConfig = {
      ...config,
      providers: remaining,
      activeProviderId: config.activeProviderId === selectedProvider.id ? nextSelected : config.activeProviderId
    }
    persistConfig(newConfig)
    setConfirmDeleteProvider(false)
  }

  const handleRenameProviderSubmit = () => {
    if (!renameValue.trim() || !selectedProvider) return
    updateCurrentProvider((p) => ({ ...p, name: renameValue.trim() }))
    setIsRenameProviderOpen(false)
    setMoreMenuOpen(false)
  }

  const handleSelectTemplate = (key: string) => {
    setSelectedTemplateKey(key)
    const tmpl = PRESET_PROVIDER_TEMPLATES.find((t) => t.key === key)
    if (tmpl) {
      setNewProviderName(tmpl.name)
      setNewProviderBaseURL(tmpl.baseURL)
      setNewProviderFormat(tmpl.apiFormat)
    }
  }

  // Add Provider
  const handleAddProviderSubmit = () => {
    if (!newProviderName.trim()) return
    const tmpl = PRESET_PROVIDER_TEMPLATES.find((t) => t.key === selectedTemplateKey)
    const initialModels: ModelItem[] =
      tmpl && tmpl.models.length > 0
        ? tmpl.models.map((m) => ({ ...m }))
        : [{ id: 'default-model', name: 'Default Model', tags: ['1M'], enabled: true }]

    const newId = `custom-${Date.now()}`
    const newProv: ModelProvider = {
      id: newId,
      name: newProviderName.trim(),
      group: 'custom',
      enabled: true,
      baseURL: newProviderBaseURL.trim() || 'https://api.openai.com/v1',
      apiKey: newProviderApiKey.trim(),
      apiFormat: newProviderFormat,
      models: initialModels
    }
    const updated = [...providers, newProv]
    setSelectedProviderId(newId)
    setIsAddProviderOpen(false)
    setNewProviderName('')
    setNewProviderBaseURL('')
    setNewProviderApiKey('')
    setSelectedTemplateKey('')
    persistConfig({ ...config, providers: updated, activeProviderId: newId })
  }

  // Ping / Connectivity Test
  const handleTestConnectivity = async (provider: ModelProvider, modelId?: string) => {
    if (!provider) return
    const key = modelId ? `model-${provider.id}-${modelId}` : `provider-${provider.id}`
    setTestingKey(key)

    try {
      const targetModelId =
        modelId || provider.models.find((m) => m.enabled)?.id || provider.models[0]?.id
      const res = await window.electronAPI?.testProviderConnectivity?.({
        baseURL: provider.baseURL,
        apiKey: provider.apiKey,
        apiFormat: provider.apiFormat,
        modelId: targetModelId
      })
      if (res) {
        setTestResults((prev) => ({
          ...prev,
          [key]: res,
          ...(!modelId ? { [`provider-${provider.id}`]: res } : {})
        }))
      }
    } catch (err: any) {
      setTestResults((prev) => ({
        ...prev,
        [key]: { success: false, latencyMs: 0, error: err.message || '测试失败' },
        ...(!modelId
          ? { [`provider-${provider.id}`]: { success: false, latencyMs: 0, error: err.message || '测试失败' } }
          : {})
      }))
    } finally {
      setTestingKey(null)
    }
  }

  // Model Tag Toggle
  const handleToggleTag = (tag: string) => {
    const currentTags = modelModalTags
      .split(/[,，]/)
      .map((t) => t.trim())
      .filter(Boolean)
    const exists = currentTags.includes(tag)
    const nextTags = exists ? currentTags.filter((t) => t !== tag) : [...currentTags, tag]
    setModelModalTags(nextTags.join(', '))
  }

  // Model List Actions
  const handleSetActiveModel = async (modelId: string) => {
    if (!selectedProvider) return
    const newConfig = {
      ...config,
      activeModelId: modelId,
      activeProviderId: selectedProvider.id
    }
    persistConfig(newConfig)
    await window.electronAPI?.switchModel?.(modelId, selectedProvider.id)
  }

  const handleToggleModel = (modelId: string) => {
    if (!selectedProvider) return
    const willBeEnabled = !selectedProvider.models.find((m) => m.id === modelId)?.enabled
    const updatedModels = selectedProvider.models.map((m) =>
      m.id === modelId ? { ...m, enabled: !m.enabled } : m
    )

    let newActiveModelId = config.activeModelId
    let newActiveProviderId = config.activeProviderId

    if (!willBeEnabled && config.activeModelId === modelId && config.activeProviderId === selectedProvider.id) {
      const nextEnabledInProvider = updatedModels.find((m) => m.enabled)
      if (nextEnabledInProvider) {
        newActiveModelId = nextEnabledInProvider.id
      } else {
        for (const p of providers) {
          if (p.id === selectedProvider.id || !p.enabled) continue
          const other = p.models.find((m) => m.enabled)
          if (other) {
            newActiveModelId = other.id
            newActiveProviderId = p.id
            break
          }
        }
      }
    }

    const updatedProviders = providers.map((p) =>
      p.id === selectedProvider.id ? { ...p, models: updatedModels } : p
    )
    const newConfig = {
      ...config,
      providers: updatedProviders,
      activeModelId: newActiveModelId,
      activeProviderId: newActiveProviderId
    }
    persistConfig(newConfig)
    if (
      newActiveModelId &&
      (newActiveModelId !== config.activeModelId || newActiveProviderId !== config.activeProviderId)
    ) {
      window.electronAPI?.switchModel?.(newActiveModelId, newActiveProviderId)
    }
  }

  const handleDeleteModel = (modelId: string) => {
    if (!selectedProvider) return
    const updatedModels = selectedProvider.models.filter((m) => m.id !== modelId)
    let newActiveModelId = config.activeModelId
    let newActiveProviderId = config.activeProviderId

    if (config.activeModelId === modelId && config.activeProviderId === selectedProvider.id) {
      const nextEnabled = updatedModels.find((m) => m.enabled)
      if (nextEnabled) {
        newActiveModelId = nextEnabled.id
      }
    }

    const updatedProviders = providers.map((p) =>
      p.id === selectedProvider.id ? { ...p, models: updatedModels } : p
    )
    const newConfig = {
      ...config,
      providers: updatedProviders,
      activeModelId: newActiveModelId,
      activeProviderId: newActiveProviderId
    }
    persistConfig(newConfig)
    if (newActiveModelId && newActiveModelId !== config.activeModelId) {
      window.electronAPI?.switchModel?.(newActiveModelId, newActiveProviderId)
    }
  }

  const handleOpenAddModel = () => {
    setEditingModelIndex(null)
    setModelModalId('')
    setModelModalName('')
    setModelModalTags('1M')
    setModelModalSetActive(true)
    setIsModelModalOpen(true)
  }

  const handleOpenEditModel = (index: number) => {
    if (!selectedProvider) return
    const target = selectedProvider.models[index]
    if (!target) return
    setEditingModelIndex(index)
    setModelModalId(target.id)
    setModelModalName(target.name || target.id)
    setModelModalTags(target.tags?.join(', ') || '')
    setIsModelModalOpen(true)
  }

  const handleSaveModel = () => {
    if (!modelModalId.trim() || !selectedProvider) return
    const tags = modelModalTags
      .split(/[,，]/)
      .map((t) => t.trim())
      .filter(Boolean)

    if (editingModelIndex === null) {
      // Add
      const newModel: ModelItem = {
        id: modelModalId.trim(),
        name: modelModalName.trim() || modelModalId.trim(),
        tags,
        enabled: true
      }
      const updatedModels = [...selectedProvider.models, newModel]
      const updatedProviders = providers.map((p) =>
        p.id === selectedProvider.id ? { ...p, models: updatedModels } : p
      )
      const newConfig = {
        ...config,
        providers: updatedProviders,
        activeModelId: modelModalSetActive ? newModel.id : config.activeModelId,
        activeProviderId: modelModalSetActive ? selectedProvider.id : config.activeProviderId
      }
      persistConfig(newConfig)
      if (modelModalSetActive) {
        window.electronAPI?.switchModel?.(newModel.id, selectedProvider.id)
      }
    } else {
      // Edit
      const oldModel = selectedProvider.models[editingModelIndex]
      const newId = modelModalId.trim()
      const updatedModels = selectedProvider.models.map((m, idx) =>
        idx === editingModelIndex
          ? {
              ...m,
              id: newId,
              name: modelModalName.trim() || newId,
              tags
            }
          : m
      )
      const updatedProviders = providers.map((p) =>
        p.id === selectedProvider.id ? { ...p, models: updatedModels } : p
      )
      const isCurrentlyActive =
        oldModel &&
        config.activeModelId === oldModel.id &&
        config.activeProviderId === selectedProvider.id
      const newConfig = {
        ...config,
        providers: updatedProviders,
        activeModelId: isCurrentlyActive ? newId : config.activeModelId
      }
      persistConfig(newConfig)
      if (isCurrentlyActive && newId !== oldModel.id) {
        window.electronAPI?.switchModel?.(newId, selectedProvider.id)
      }
    }
    setIsModelModalOpen(false)
  }

  // Grouped providers for sidebar
  const presetProviders = providers.filter((p) => p.group === 'preset' || !p.group)
  const customProviders = providers.filter((p) => p.group === 'custom')

  // Active model indicator
  const activePair = findActiveModelAndProvider(providers, config.activeModelId, config.activeProviderId)
  const activeModelDisplay = activePair
    ? `${activePair.provider.name} · ${activePair.model.name || activePair.model.id}`
    : ''

  return (
    <div className="fixed inset-0 z-50 bg-[#f8f9fa] text-neutral-800 flex font-sans select-none overflow-hidden animate-in fade-in duration-150">
      {/* 1. Left Navigation Sidebar (Light Theme 1:1 Antigravity) */}
      <div className="w-56 bg-[#fbfbfb] border-r border-neutral-200/80 flex flex-col justify-between shrink-0">
        <div className="flex flex-col">
          {/* Back to Workspace button */}
          <div className="p-3 border-b border-neutral-200/80">
            <button
              type="button"
              onClick={onClose}
              className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-white hover:bg-neutral-100 border border-neutral-200 text-neutral-700 text-xs font-medium shadow-2xs transition-colors"
            >
              <ArrowLeft className="w-4 h-4 text-neutral-500" />
              <span>返回工作区</span>
            </button>
          </div>

          {/* Nav Categories */}
          <div className="px-3 py-3 space-y-4 overflow-y-auto max-h-[calc(100vh-120px)]">
            {/* 基础设置 */}
            <div>
              <div className="px-2.5 py-1 text-[11px] font-semibold text-neutral-400 uppercase tracking-wider">
                基础设置
              </div>
              <div className="space-y-0.5 mt-1">
                <button
                  type="button"
                  onClick={() => setActiveTab('general')}
                  className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs transition-colors ${
                    activeTab === 'general'
                      ? 'bg-neutral-200/70 text-neutral-900 font-medium'
                      : 'text-neutral-600 hover:text-neutral-900 hover:bg-neutral-100'
                  }`}
                >
                  <SlidersHorizontal className="w-3.5 h-3.5 text-neutral-500" />
                  <span>常规</span>
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('appearance')}
                  className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs transition-colors ${
                    activeTab === 'appearance'
                      ? 'bg-neutral-200/70 text-neutral-900 font-medium'
                      : 'text-neutral-600 hover:text-neutral-900 hover:bg-neutral-100'
                  }`}
                >
                  <Palette className="w-3.5 h-3.5 text-neutral-500" />
                  <span>外观</span>
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('model')}
                  className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs transition-colors ${
                    activeTab === 'model'
                      ? 'bg-blue-50 text-blue-600 font-semibold'
                      : 'text-neutral-600 hover:text-neutral-900 hover:bg-neutral-100'
                  }`}
                >
                  <Box className="w-3.5 h-3.5 text-blue-600" />
                  <span>模型设置</span>
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('browser')}
                  className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs transition-colors ${
                    activeTab === 'browser'
                      ? 'bg-neutral-200/70 text-neutral-900 font-medium'
                      : 'text-neutral-600 hover:text-neutral-900 hover:bg-neutral-100'
                  }`}
                >
                  <Globe className="w-3.5 h-3.5 text-neutral-500" />
                  <span>浏览器控制</span>
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('computer')}
                  className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs transition-colors ${
                    activeTab === 'computer'
                      ? 'bg-neutral-200/70 text-neutral-900 font-medium'
                      : 'text-neutral-600 hover:text-neutral-900 hover:bg-neutral-100'
                  }`}
                >
                  <Monitor className="w-3.5 h-3.5 text-neutral-500" />
                  <span>电脑控制</span>
                </button>
              </div>
            </div>

            {/* Agent 能力 */}
            <div>
              <div className="px-2.5 py-1 text-[11px] font-semibold text-neutral-400 uppercase tracking-wider">
                Agent 能力
              </div>
              <div className="space-y-0.5 mt-1">
                {[
                  { id: 'memory', label: '记忆', icon: Brain },
                  { id: 'subagents', label: '子智能体', icon: Bot },
                  { id: 'plugins', label: '插件', icon: Puzzle },
                  { id: 'mcp', label: 'MCP 服务器', icon: Server },
                  { id: 'skills', label: '技能', icon: Sparkles },
                  { id: 'commands', label: '命令', icon: Terminal },
                  { id: 'hooks', label: '钩子', icon: Anchor }
                ].map((item) => {
                  const Icon = item.icon
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setActiveTab(item.id)}
                      className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs transition-colors ${
                        activeTab === item.id
                          ? 'bg-neutral-200/70 text-neutral-900 font-medium'
                          : 'text-neutral-600 hover:text-neutral-900 hover:bg-neutral-100'
                      }`}
                    >
                      <Icon className="w-3.5 h-3.5 text-neutral-500" />
                      <span>{item.label}</span>
                    </button>
                  )
                })}
              </div>
            </div>

            {/* 数据与统计 */}
            <div>
              <div className="px-2.5 py-1 text-[11px] font-semibold text-neutral-400 uppercase tracking-wider">
                数据与统计
              </div>
              <div className="space-y-0.5 mt-1">
                <button
                  type="button"
                  onClick={() => setActiveTab('indexes')}
                  className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs transition-colors ${
                    activeTab === 'indexes'
                      ? 'bg-neutral-200/70 text-neutral-900 font-medium'
                      : 'text-neutral-600 hover:text-neutral-900 hover:bg-neutral-100'
                  }`}
                >
                  <Database className="w-3.5 h-3.5 text-neutral-500" />
                  <span>索引库</span>
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('stats')}
                  className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs transition-colors ${
                    activeTab === 'stats'
                      ? 'bg-neutral-200/70 text-neutral-900 font-medium'
                      : 'text-neutral-600 hover:text-neutral-900 hover:bg-neutral-100'
                  }`}
                >
                  <BarChart3 className="w-3.5 h-3.5 text-neutral-500" />
                  <span>使用统计</span>
                </button>
              </div>
            </div>

            {/* 引导 */}
            <div>
              <button
                type="button"
                onClick={() => setActiveTab('guide')}
                className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs transition-colors ${
                  activeTab === 'guide'
                    ? 'bg-neutral-200/70 text-neutral-900 font-medium'
                    : 'text-neutral-600 hover:text-neutral-900 hover:bg-neutral-100'
                }`}
              >
                <BookOpen className="w-3.5 h-3.5 text-neutral-500" />
                <span>引导</span>
              </button>
            </div>
          </div>
        </div>

        {/* Bottom user status */}
        <div className="p-3 border-t border-neutral-200/80 flex items-center justify-between text-xs text-neutral-500">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-full bg-neutral-200 flex items-center justify-center text-neutral-700 font-medium">
              <User className="w-3.5 h-3.5" />
            </div>
            <span className="text-neutral-700 text-[11px] font-medium">连接使用</span>
          </div>
          <Settings className="w-3.5 h-3.5 text-neutral-400 hover:text-neutral-700 cursor-pointer" />
        </div>
      </div>

      {/* 2. Main Content Area */}
      <div className="flex-1 flex flex-col bg-[#f8f9fa] overflow-y-auto">
        {activeTab === 'model' ? (
          <div className="p-8 max-w-5xl w-full mx-auto flex flex-col min-h-full">
            {/* Header */}
            <div className="flex items-center justify-between pb-6 border-b border-neutral-200/80">
              <div>
                <div className="flex items-center gap-3">
                  <h1 className="text-xl font-bold text-neutral-900 tracking-tight">模型设置</h1>
                  {activeModelDisplay && (
                    <span className="px-2.5 py-1 rounded-lg bg-blue-50 border border-blue-200 text-blue-700 text-xs font-medium flex items-center gap-1.5 shadow-2xs">
                      <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
                      当前生效: <span className="font-semibold">{activeModelDisplay}</span>
                    </span>
                  )}
                </div>
                <p className="text-xs text-neutral-500 mt-1">
                  管理自定义模型供应商，配置后可在聊天时选择使用。
                </p>
              </div>
              <div className="flex items-center gap-3">
                {saveStatus === 'saved' && (
                  <span className="text-emerald-600 text-xs flex items-center gap-1 font-medium">
                    <Check className="w-3.5 h-3.5" /> 已保存
                  </span>
                )}
                <button
                  type="button"
                  onClick={reloadConfig}
                  className="p-1.5 rounded-lg bg-white hover:bg-neutral-100 border border-neutral-200 text-neutral-600 shadow-2xs transition-colors"
                  title="刷新配置"
                >
                  <RotateCw className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setIsAddProviderOpen(true)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold shadow-xs transition-colors"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>添加供应商</span>
                </button>
              </div>
            </div>

            {/* Two Column Layout */}
            <div className="flex gap-6 mt-6 flex-1 items-start">
              {/* Left Column: Provider List */}
              <div className="w-64 shrink-0 space-y-4">
                {/* 预设供应商 */}
                {presetProviders.length > 0 && (
                  <div>
                    <div className="px-2 py-1 text-[11px] font-semibold text-neutral-400 uppercase tracking-wider">
                      预设供应商
                    </div>
                    <div className="space-y-1 mt-1">
                      {presetProviders.map((p) => {
                        const isSelected = selectedProvider?.id === p.id
                        const hasCreds = Boolean(p.apiKey || p.baseURL.includes('localhost') || p.baseURL.includes('11434'))
                        const isOnline = p.enabled && hasCreds
                        return (
                          <button
                            key={p.id}
                            type="button"
                            onClick={() => setSelectedProviderId(p.id)}
                            className={`w-full flex items-center justify-between px-3 py-2 rounded-xl text-xs transition-all ${
                              isSelected
                                ? 'bg-white border border-neutral-200/90 text-neutral-900 font-medium shadow-2xs'
                                : 'text-neutral-600 hover:text-neutral-900 hover:bg-neutral-100/70 border border-transparent'
                            }`}
                          >
                            <div className="flex items-center gap-2.5 truncate">
                              <div
                                className={`w-5 h-5 rounded-md flex items-center justify-center text-[10px] font-bold shrink-0 ${
                                  isSelected
                                    ? 'bg-blue-50 text-blue-600 border border-blue-200'
                                    : 'bg-neutral-100 text-neutral-600 border border-neutral-200'
                                }`}
                              >
                                {p.name.slice(0, 1).toUpperCase()}
                              </div>
                              <span className="truncate">{p.name}</span>
                            </div>
                            {testResults[`provider-${p.id}`] ? (
                              testResults[`provider-${p.id}`].success ? (
                                <span className="text-[10px] font-mono text-emerald-600 font-semibold px-1 py-0.5 rounded bg-emerald-50 border border-emerald-200 shrink-0">
                                  {testResults[`provider-${p.id}`].latencyMs}ms
                                </span>
                              ) : (
                                <span
                                  className="text-[10px] text-rose-500 font-medium px-1 py-0.5 rounded bg-rose-50 border border-rose-200 shrink-0"
                                  title={testResults[`provider-${p.id}`].error}
                                >
                                  失败
                                </span>
                              )
                            ) : (
                              <span
                                className={`w-2 h-2 rounded-full shrink-0 ${
                                  isOnline ? 'bg-emerald-500' : 'bg-amber-400'
                                }`}
                                title={isOnline ? '已启用并配置' : '未完整配置或已停用'}
                              />
                            )}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}

                {/* 自定义供应商 */}
                <div>
                  <div className="px-2 py-1 text-[11px] font-semibold text-neutral-400 uppercase tracking-wider">
                    自定义供应商
                  </div>
                  <div className="space-y-1 mt-1">
                    {customProviders.length === 0 ? (
                      <div className="px-3 py-2 text-[11px] text-neutral-400 italic">
                        暂无自定义供应商，点击上方 "+ 添加供应商" 创建。
                      </div>
                    ) : (
                      customProviders.map((p) => {
                        const isSelected = selectedProvider?.id === p.id
                        const hasCreds = Boolean(p.apiKey)
                        const isOnline = p.enabled && hasCreds
                        return (
                          <button
                            key={p.id}
                            type="button"
                            onClick={() => setSelectedProviderId(p.id)}
                            className={`w-full flex items-center justify-between px-3 py-2 rounded-xl text-xs transition-all ${
                              isSelected
                                ? 'bg-white border border-neutral-200/90 text-neutral-900 font-medium shadow-2xs'
                                : 'text-neutral-600 hover:text-neutral-900 hover:bg-neutral-100/70 border border-transparent'
                            }`}
                          >
                            <div className="flex items-center gap-2.5 truncate">
                              <div
                                className={`w-5 h-5 rounded-md flex items-center justify-center text-[10px] font-bold shrink-0 ${
                                  isSelected
                                    ? 'bg-blue-50 text-blue-600 border border-blue-200'
                                    : 'bg-neutral-100 text-neutral-600 border border-neutral-200'
                                }`}
                              >
                                {p.name.slice(0, 1).toUpperCase()}
                              </div>
                              <span className="truncate">{p.name}</span>
                            </div>
                            {testResults[`provider-${p.id}`] ? (
                              testResults[`provider-${p.id}`].success ? (
                                <span className="text-[10px] font-mono text-emerald-600 font-semibold px-1 py-0.5 rounded bg-emerald-50 border border-emerald-200 shrink-0">
                                  {testResults[`provider-${p.id}`].latencyMs}ms
                                </span>
                              ) : (
                                <span
                                  className="text-[10px] text-rose-500 font-medium px-1 py-0.5 rounded bg-rose-50 border border-rose-200 shrink-0"
                                  title={testResults[`provider-${p.id}`].error}
                                >
                                  失败
                                </span>
                              )
                            ) : (
                              <span
                                className={`w-2 h-2 rounded-full shrink-0 ${
                                  isOnline ? 'bg-emerald-500' : 'bg-amber-400'
                                }`}
                                title={isOnline ? '已启用并配置' : '未完整配置或已停用'}
                              />
                            )}
                          </button>
                        )
                      })
                    )}
                  </div>
                </div>
              </div>

              {/* Right Column: Selected Provider Config Card */}
              {selectedProvider ? (
                <div className="flex-1 bg-white border border-neutral-200/90 rounded-2xl p-6 shadow-xs space-y-5">
                  {/* Card Header */}
                  <div className="flex items-center justify-between pb-4 border-b border-neutral-200/80">
                    <div className="flex items-center gap-2.5">
                      <div className="w-7 h-7 rounded-lg bg-blue-50 border border-blue-200 flex items-center justify-center text-xs font-bold text-blue-600">
                        {selectedProvider.name.slice(0, 1).toUpperCase()}
                      </div>
                      <span className="text-base font-semibold text-neutral-900">
                        {selectedProvider.name}
                      </span>
                      {testResults[`provider-${selectedProvider.id}`] && (
                        testResults[`provider-${selectedProvider.id}`].success ? (
                          <span
                            className="px-2 py-0.5 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs font-mono font-medium flex items-center gap-1 shadow-2xs"
                            title={`连通正常 (HTTP ${testResults[`provider-${selectedProvider.id}`].statusCode || 200})`}
                          >
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                            {testResults[`provider-${selectedProvider.id}`].latencyMs}ms
                          </span>
                        ) : (
                          <span
                            className="px-2 py-0.5 rounded-full bg-rose-50 border border-rose-200 text-rose-700 text-xs font-medium flex items-center gap-1 max-w-[200px] truncate shadow-2xs"
                            title={testResults[`provider-${selectedProvider.id}`].error}
                          >
                            <span className="w-1.5 h-1.5 rounded-full bg-rose-500 shrink-0" />
                            <span className="truncate">{testResults[`provider-${selectedProvider.id}`].error || '连接失败'}</span>
                          </span>
                        )
                      )}
                    </div>

                    <div className="flex items-center gap-2.5">
                      {/* Test Connectivity Button */}
                      <button
                        type="button"
                        onClick={() => handleTestConnectivity(selectedProvider)}
                        disabled={testingKey === `provider-${selectedProvider.id}`}
                        className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-neutral-50 hover:bg-neutral-100 border border-neutral-200/90 text-neutral-700 text-xs font-medium transition-colors shadow-2xs cursor-pointer disabled:opacity-50"
                        title="测试该供应商 API 连通性与网络延迟"
                      >
                        {testingKey === `provider-${selectedProvider.id}` ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-600" />
                        ) : (
                          <Activity className="w-3.5 h-3.5 text-neutral-500" />
                        )}
                        <span>{testingKey === `provider-${selectedProvider.id}` ? '测速中...' : '测试连接'}</span>
                      </button>

                      {/* Enable toggle switch */}
                      <button
                        type="button"
                        onClick={handleToggleProviderEnabled}
                        className={`w-9 h-5 rounded-full p-0.5 transition-colors cursor-pointer ${
                          selectedProvider.enabled ? 'bg-emerald-500' : 'bg-neutral-300'
                        }`}
                        title={selectedProvider.enabled ? '停用此供应商' : '启用此供应商'}
                      >
                        <div
                          className={`w-4 h-4 rounded-full bg-white shadow-xs transition-transform ${
                            selectedProvider.enabled ? 'translate-x-4' : 'translate-x-0'
                          }`}
                        />
                      </button>

                      {/* More actions menu */}
                      <div className="relative">
                        <button
                          type="button"
                          onClick={() => setMoreMenuOpen(!moreMenuOpen)}
                          className="p-1 rounded-md text-neutral-400 hover:text-neutral-700 hover:bg-neutral-100 transition-colors"
                        >
                          <MoreHorizontal className="w-4 h-4" />
                        </button>

                        {moreMenuOpen && (
                          <div className="absolute right-0 mt-1 w-32 bg-white border border-neutral-200 rounded-xl shadow-xl py-1 z-20 text-xs">
                            <button
                              type="button"
                              onClick={() => {
                                setRenameValue(selectedProvider.name)
                                setIsRenameProviderOpen(true)
                              }}
                              className="w-full text-left px-3 py-1.5 hover:bg-neutral-50 text-neutral-700"
                            >
                              重命名供应商
                            </button>
                            <button
                              type="button"
                              onClick={handleDeleteProvider}
                              className="w-full text-left px-3 py-1.5 hover:bg-rose-50 text-rose-600"
                            >
                              删除供应商
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Form fields */}
                  <div className="space-y-4">
                    {/* Base URL */}
                    <div>
                      <label className="block text-xs font-medium text-neutral-600 mb-1.5">
                        Base URL
                      </label>
                      <input
                        type="text"
                        value={selectedProvider.baseURL || ''}
                        onChange={(e) =>
                          updateCurrentProvider((p) => ({ ...p, baseURL: e.target.value }))
                        }
                        placeholder="https://api.openai.com/v1"
                        className="w-full bg-neutral-50 hover:bg-white focus:bg-white border border-neutral-200/90 rounded-xl px-3.5 py-2 text-xs text-neutral-900 placeholder-neutral-400 focus:outline-none focus:border-blue-500 font-mono transition-colors"
                      />
                    </div>

                    {/* API Key */}
                    <div>
                      <label className="block text-xs font-medium text-neutral-600 mb-1.5">
                        API Key
                      </label>
                      <div className="relative">
                        <input
                          type={showApiKey ? 'text' : 'password'}
                          value={selectedProvider.apiKey || ''}
                          onChange={(e) =>
                            updateCurrentProvider((p) => ({ ...p, apiKey: e.target.value }))
                          }
                          placeholder="sk-..."
                          className="w-full bg-neutral-50 hover:bg-white focus:bg-white border border-neutral-200/90 rounded-xl px-3.5 py-2 pr-9 text-xs text-neutral-900 placeholder-neutral-400 focus:outline-none focus:border-blue-500 font-mono transition-colors"
                        />
                        <button
                          type="button"
                          onClick={() => setShowApiKey(!showApiKey)}
                          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-600"
                        >
                          {showApiKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                        </button>
                      </div>
                    </div>

                    {/* API 格式 (Dropdown) */}
                    <div>
                      <label className="block text-xs font-medium text-neutral-600 mb-1.5">
                        API 格式
                      </label>
                      <ApiFormatDropdown
                        value={selectedProvider.apiFormat}
                        onChange={(val) =>
                          updateCurrentProvider((p) => ({ ...p, apiFormat: val }))
                        }
                      />
                    </div>


                    {/* 模型列表 */}
                    <div className="pt-2">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-semibold text-neutral-800">模型列表</span>
                        <button
                          type="button"
                          onClick={handleOpenAddModel}
                          className="flex items-center gap-1 text-xs text-neutral-500 hover:text-blue-600 transition-colors font-medium"
                        >
                          <Plus className="w-3.5 h-3.5" />
                          <span>添加模型</span>
                        </button>
                      </div>

                      {/* Model rows */}
                      <div className="bg-neutral-50 border border-neutral-200/90 rounded-xl overflow-hidden divide-y divide-neutral-200/70">
                        {selectedProvider.models.length === 0 ? (
                          <div className="p-4 text-xs text-neutral-400 text-center italic">
                            暂无模型，请点击右上方 "+ 添加模型"
                          </div>
                        ) : (
                          selectedProvider.models.map((m, idx) => {
                          const modelTestKey = `model-${selectedProvider.id}-${m.id}`
                          const isModelTesting = testingKey === modelTestKey
                          const modelLatency = testResults[modelTestKey]

                          return (
                            <div
                              key={m.id}
                              className="px-3.5 py-2.5 flex items-center justify-between hover:bg-neutral-100/60 transition-colors"
                            >
                              <div className="flex items-center gap-2 truncate">
                                <span className="text-xs font-medium text-neutral-800 truncate">
                                  {m.name || m.id}
                                </span>
                                {m.tags && m.tags.length > 0 && (
                                  <div className="flex items-center gap-1 shrink-0">
                                    {m.tags.map((tag) => (
                                      <span
                                        key={tag}
                                        className="px-1.5 py-0.5 rounded bg-white border border-neutral-200/80 text-[10px] text-neutral-600 font-mono"
                                      >
                                        {tag}
                                      </span>
                                    ))}
                                  </div>
                                )}
                              </div>

                              <div className="flex items-center gap-2 shrink-0">
                                {/* Model ping result badge */}
                                {modelLatency && (
                                  modelLatency.success ? (
                                    <span
                                      className="px-1.5 py-0.5 rounded bg-emerald-50 border border-emerald-200 text-emerald-700 text-[10px] font-mono font-medium flex items-center gap-1"
                                      title={`响应正常: ${modelLatency.latencyMs}ms`}
                                    >
                                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                                      {modelLatency.latencyMs}ms
                                    </span>
                                  ) : (
                                    <span
                                      className="px-1.5 py-0.5 rounded bg-rose-50 border border-rose-200 text-rose-700 text-[10px] font-medium max-w-[130px] truncate flex items-center gap-1"
                                      title={modelLatency.error}
                                    >
                                      <span className="w-1.5 h-1.5 rounded-full bg-rose-500 shrink-0" />
                                      <span className="truncate">{modelLatency.error || '失败'}</span>
                                    </span>
                                  )
                                )}

                                {/* Model ping button */}
                                <button
                                  type="button"
                                  onClick={() => handleTestConnectivity(selectedProvider, m.id)}
                                  disabled={isModelTesting}
                                  className="p-1 text-neutral-400 hover:text-blue-600 transition-colors disabled:opacity-50 cursor-pointer"
                                  title="测速该模型"
                                >
                                  {isModelTesting ? (
                                    <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-600" />
                                  ) : (
                                    <Activity className="w-3.5 h-3.5" />
                                  )}
                                </button>

                                {config.activeModelId === m.id && config.activeProviderId === selectedProvider.id ? (
                                  <span className="px-2 py-0.5 rounded-full bg-blue-50 border border-blue-200 text-blue-600 font-medium text-[11px] flex items-center gap-1 shrink-0">
                                    <Check className="w-3 h-3 text-blue-600" />
                                    <span>当前生效</span>
                                  </span>
                                ) : m.enabled ? (
                                  <button
                                    type="button"
                                    onClick={() => handleSetActiveModel(m.id)}
                                    className="px-2 py-0.5 rounded-md text-[11px] text-neutral-500 hover:text-blue-600 hover:bg-blue-50 border border-transparent hover:border-blue-100 transition-colors shrink-0 font-medium cursor-pointer"
                                    title="设为当前生效模型"
                                  >
                                    设为当前
                                  </button>
                                ) : null}

                                <button
                                  type="button"
                                  onClick={() => handleOpenEditModel(idx)}
                                  className="p-1 text-neutral-400 hover:text-neutral-700 transition-colors cursor-pointer"
                                  title="编辑模型"
                                >
                                  <Pencil className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleDeleteModel(m.id)}
                                  className="p-1 text-neutral-400 hover:text-rose-600 transition-colors cursor-pointer"
                                  title="删除模型"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                                {/* Model enabled switch */}
                                <button
                                  type="button"
                                  onClick={() => handleToggleModel(m.id)}
                                  className={`w-7 h-4 rounded-full p-0.5 transition-colors cursor-pointer ${
                                    m.enabled ? 'bg-emerald-500' : 'bg-neutral-300'
                                  }`}
                                  title={m.enabled ? '已启用' : '已停用'}
                                >
                                  <div
                                    className={`w-3 h-3 rounded-full bg-white shadow-2xs transition-transform ${
                                      m.enabled ? 'translate-x-3' : 'translate-x-0'
                                    }`}
                                  />
                                </button>
                              </div>
                            </div>
                          )
                        })
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex-1 p-8 text-neutral-400 text-center">
                  请选择或添加供应商
                </div>
              )}
            </div>
          </div>
        ) : (
          /* Placeholder for other tabs */
          <div className="p-8 max-w-xl mx-auto flex flex-col justify-center items-center text-center my-auto space-y-3">
            <div className="w-12 h-12 rounded-2xl bg-white border border-neutral-200 shadow-2xs flex items-center justify-center text-neutral-500">
              <Settings className="w-6 h-6" />
            </div>
            <h2 className="text-base font-semibold text-neutral-900">配置项设置</h2>
            <p className="text-xs text-neutral-500">
              当前页面功能将在后续模块中扩展。您可以前往“模型设置”配置核心 LLM 接口与模型列表。
            </p>
            <button
              type="button"
              onClick={() => setActiveTab('model')}
              className="mt-2 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold shadow-xs"
            >
              前往模型设置
            </button>
          </div>
        )}
      </div>

      {/* 3. Add Provider Modal */}
      {isAddProviderOpen && (
        <div className="fixed inset-0 z-60 bg-black/30 backdrop-blur-2xs flex items-center justify-center p-4">
          <div className="bg-white border border-neutral-200 rounded-2xl w-full max-w-md p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-neutral-200">
              <h3 className="text-sm font-bold text-neutral-900">添加自定义供应商</h3>
              <button
                type="button"
                onClick={() => setIsAddProviderOpen(false)}
                className="text-neutral-400 hover:text-neutral-700"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3.5 text-xs">
              {/* Template Quick Selection */}
              <div>
                <label className="block text-neutral-600 mb-1.5 font-medium flex items-center justify-between">
                  <span>从常用服务商模板快速导入</span>
                  <span className="text-[10px] text-neutral-400 font-normal">点击自动填充常用配置</span>
                </label>
                <div className="grid grid-cols-3 gap-1.5 max-h-36 overflow-y-auto p-1.5 bg-neutral-50 rounded-xl border border-neutral-200/80">
                  {PRESET_PROVIDER_TEMPLATES.map((tmpl) => {
                    const isSelected = selectedTemplateKey === tmpl.key
                    return (
                      <button
                        key={tmpl.key}
                        type="button"
                        onClick={() => handleSelectTemplate(tmpl.key)}
                        className={`px-2.5 py-1.5 rounded-lg text-left transition-all border cursor-pointer ${
                          isSelected
                            ? 'bg-blue-50 border-blue-300 text-blue-700 font-medium shadow-2xs'
                            : 'bg-white hover:bg-neutral-100/80 border-neutral-200/60 text-neutral-700'
                        }`}
                      >
                        <div className="truncate font-medium text-[11px]">{tmpl.name.split(' ')[0]}</div>
                        <div className="text-[10px] text-neutral-400 truncate mt-0.5">
                          {tmpl.apiFormat === 'anthropic_messages'
                            ? 'Anthropic'
                            : tmpl.apiFormat === 'responses'
                            ? 'Responses'
                            : 'OpenAI'}
                        </div>
                      </button>
                    )
                  })}
                </div>
              </div>

              <div>
                <label className="block text-neutral-600 mb-1 font-medium">供应商名称</label>
                <input
                  type="text"
                  value={newProviderName}
                  onChange={(e) => setNewProviderName(e.target.value)}
                  placeholder="例如: Z.ai Coding Plan 2"
                  className="w-full bg-neutral-50 hover:bg-white focus:bg-white border border-neutral-200 rounded-xl px-3 py-2 text-neutral-900 placeholder-neutral-400 focus:outline-none focus:border-blue-500 transition-colors"
                />
              </div>

              <div>
                <label className="block text-neutral-600 mb-1 font-medium">Base URL</label>
                <input
                  type="text"
                  value={newProviderBaseURL}
                  onChange={(e) => setNewProviderBaseURL(e.target.value)}
                  placeholder="https://api.z.ai/api/anthropic"
                  className="w-full bg-neutral-50 hover:bg-white focus:bg-white border border-neutral-200 rounded-xl px-3 py-2 text-neutral-900 placeholder-neutral-400 focus:outline-none focus:border-blue-500 font-mono transition-colors"
                />
              </div>

              <div>
                <label className="block text-neutral-600 mb-1 font-medium">API Key</label>
                <input
                  type="password"
                  value={newProviderApiKey}
                  onChange={(e) => setNewProviderApiKey(e.target.value)}
                  placeholder="sk-..."
                  className="w-full bg-neutral-50 hover:bg-white focus:bg-white border border-neutral-200 rounded-xl px-3 py-2 text-neutral-900 placeholder-neutral-400 focus:outline-none focus:border-blue-500 font-mono transition-colors"
                />
              </div>

              <div>
                <label className="block text-neutral-600 mb-1 font-medium">API 格式</label>
                <ApiFormatDropdown
                  value={newProviderFormat}
                  onChange={(val) => setNewProviderFormat(val)}
                />
              </div>

            </div>

            <div className="flex items-center justify-end gap-2 pt-3 border-t border-neutral-200">
              <button
                type="button"
                onClick={() => setIsAddProviderOpen(false)}
                className="px-3 py-1.5 rounded-lg bg-neutral-100 text-neutral-700 hover:bg-neutral-200 text-xs font-medium transition-colors cursor-pointer"
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleAddProviderSubmit}
                disabled={!newProviderName.trim()}
                className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold shadow-xs disabled:opacity-50 transition-colors cursor-pointer"
              >
                添加
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 4. Add/Edit Model Modal */}
      {isModelModalOpen && (
        <div className="fixed inset-0 z-60 bg-black/30 backdrop-blur-2xs flex items-center justify-center p-4">
          <div className="bg-white border border-neutral-200 rounded-2xl w-full max-w-md p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-neutral-200">
              <h3 className="text-sm font-bold text-neutral-900">
                {editingModelIndex === null ? '添加模型' : '编辑模型'}
              </h3>
              <button
                type="button"
                onClick={() => setIsModelModalOpen(false)}
                className="text-neutral-400 hover:text-neutral-700 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div>
                <label className="block text-neutral-600 mb-1 font-medium">模型 ID (API model)</label>
                <input
                  type="text"
                  value={modelModalId}
                  onChange={(e) => setModelModalId(e.target.value)}
                  placeholder="例如: deepseek-chat, gpt-4o, claude-3-7-sonnet"
                  className="w-full bg-neutral-50 hover:bg-white focus:bg-white border border-neutral-200 rounded-xl px-3 py-2 text-neutral-900 placeholder-neutral-400 focus:outline-none focus:border-blue-500 font-mono transition-colors"
                />
              </div>

              <div>
                <label className="block text-neutral-600 mb-1 font-medium">显示名称 (可选)</label>
                <input
                  type="text"
                  value={modelModalName}
                  onChange={(e) => setModelModalName(e.target.value)}
                  placeholder="例如: DeepSeek V3 (默认同模型 ID)"
                  className="w-full bg-neutral-50 hover:bg-white focus:bg-white border border-neutral-200 rounded-xl px-3 py-2 text-neutral-900 placeholder-neutral-400 focus:outline-none focus:border-blue-500 transition-colors"
                />
              </div>

              <div>
                <label className="block text-neutral-600 mb-1 font-medium">标签徽章 (逗号分隔)</label>
                <input
                  type="text"
                  value={modelModalTags}
                  onChange={(e) => setModelModalTags(e.target.value)}
                  placeholder="例如: 1M, 思考, 视觉"
                  className="w-full bg-neutral-50 hover:bg-white focus:bg-white border border-neutral-200 rounded-xl px-3 py-2 text-neutral-900 placeholder-neutral-400 focus:outline-none focus:border-blue-500 transition-colors"
                />
                {/* Preset Tag Chips */}
                <div className="flex flex-wrap items-center gap-1.5 mt-2">
                  <span className="text-[11px] text-neutral-400">快捷点选:</span>
                  {COMMON_MODEL_TAGS.map((tag) => {
                    const activeTags = modelModalTags
                      .split(/[,，]/)
                      .map((t) => t.trim())
                      .filter(Boolean)
                    const isSelected = activeTags.includes(tag)
                    return (
                      <button
                        key={tag}
                        type="button"
                        onClick={() => handleToggleTag(tag)}
                        className={`px-2 py-0.5 rounded-md text-[11px] font-mono transition-colors cursor-pointer ${
                          isSelected
                            ? 'bg-blue-50 border border-blue-300 text-blue-700 font-semibold shadow-2xs'
                            : 'bg-neutral-100 hover:bg-neutral-200/80 border border-neutral-200 text-neutral-600'
                        }`}
                      >
                        {tag}
                      </button>
                    )
                  })}
                </div>
              </div>

              {editingModelIndex === null && (
                <label className="flex items-center gap-2 cursor-pointer select-none pt-1">
                  <input
                    type="checkbox"
                    checked={modelModalSetActive}
                    onChange={(e) => setModelModalSetActive(e.target.checked)}
                    className="w-4 h-4 rounded text-blue-600 focus:ring-blue-500 border-neutral-300"
                  />
                  <span className="text-neutral-700 font-medium">创建后立即设为当前生效模型</span>
                </label>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 pt-3 border-t border-neutral-200">
              <button
                type="button"
                onClick={() => setIsModelModalOpen(false)}
                className="px-3 py-1.5 rounded-lg bg-neutral-100 text-neutral-700 hover:bg-neutral-200 text-xs font-medium transition-colors cursor-pointer"
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleSaveModel}
                disabled={!modelModalId.trim()}
                className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold shadow-xs disabled:opacity-50 transition-colors cursor-pointer"
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 5. Rename Provider Modal */}
      {isRenameProviderOpen && (
        <div className="fixed inset-0 z-60 bg-black/30 backdrop-blur-2xs flex items-center justify-center p-4">
          <div className="bg-white border border-neutral-200 rounded-2xl w-full max-w-sm p-5 shadow-2xl space-y-4">
            <h3 className="text-sm font-bold text-neutral-900">重命名供应商</h3>
            <input
              type="text"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              className="w-full bg-neutral-50 hover:bg-white focus:bg-white border border-neutral-200 rounded-xl px-3 py-2 text-xs text-neutral-900 focus:outline-none focus:border-blue-500 transition-colors"
            />
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setIsRenameProviderOpen(false)}
                className="px-3 py-1.5 rounded-lg bg-neutral-100 text-neutral-700 hover:bg-neutral-200 text-xs transition-colors cursor-pointer"
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleRenameProviderSubmit}
                className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold shadow-xs transition-colors cursor-pointer"
              >
                确定
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 6. Confirm Delete Provider Dialog */}
      {confirmDeleteProvider && selectedProvider && (
        <div className="fixed inset-0 z-60 bg-black/30 backdrop-blur-2xs flex items-center justify-center p-4">
          <div className="bg-white border border-neutral-200 rounded-2xl w-full max-w-sm p-5 shadow-2xl space-y-4 animate-in fade-in zoom-in-95 duration-100">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-full bg-rose-50 border border-rose-200 text-rose-600 flex items-center justify-center shrink-0">
                <Trash2 className="w-4 h-4" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-neutral-900">删除供应商</h3>
                <p className="text-xs text-neutral-500 mt-0.5">
                  确定要删除供应商 <span className="font-semibold text-neutral-800">"{selectedProvider.name}"</span> 吗？此操作无法撤销。
                </p>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setConfirmDeleteProvider(false)}
                className="px-3 py-1.5 rounded-lg bg-neutral-100 text-neutral-700 hover:bg-neutral-200 text-xs font-medium transition-colors cursor-pointer"
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleDeleteProviderConfirm}
                className="px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold shadow-xs transition-colors cursor-pointer"
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
