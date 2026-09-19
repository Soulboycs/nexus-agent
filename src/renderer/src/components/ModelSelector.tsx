import React, { useState, useRef, useEffect, useCallback } from 'react'
import { ChevronUp, Settings } from 'lucide-react'
import { ModelProvider, ModelItem } from '@shared/types'
import { getEnabledModelsGrouped, findActiveModelAndProvider, getModelDef } from '@shared/models'

interface ModelSelectorProps {
  currentModelId: string
  currentProviderId?: string
  onModelChange: (modelId: string, providerId?: string) => void
  dropDirection?: 'up' | 'down'
  className?: string
  onOpenSettings?: () => void
  providers?: ModelProvider[]
}

export const ModelSelector: React.FC<ModelSelectorProps> = ({
  currentModelId,
  currentProviderId,
  onModelChange,
  dropDirection = 'up',
  className = '',
  onOpenSettings,
  providers: propProviders
}) => {
  const [isOpen, setIsOpen] = useState(false)
  const [loadedProviders, setLoadedProviders] = useState<ModelProvider[]>(propProviders || [])
  const dropdownRef = useRef<HTMLDivElement>(null)

  // Fetch real providers if not provided via props
  const fetchProviders = useCallback(async () => {
    try {
      const cfg = await window.electronAPI?.getProviderConfig?.()
      if (cfg?.providers && cfg.providers.length > 0) {
        setLoadedProviders(cfg.providers)
      }
    } catch (e) {
      console.error('Failed to fetch providers for ModelSelector:', e)
    }
  }, [])

  useEffect(() => {
    if (propProviders && propProviders.length > 0) {
      setLoadedProviders(propProviders)
    } else {
      fetchProviders()
    }
  }, [propProviders, fetchProviders])

  // Re-fetch when opened to ensure fresh list
  useEffect(() => {
    if (isOpen) {
      fetchProviders()
    }
  }, [isOpen, fetchProviders])

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

  const handleSelect = async (modelId: string, providerId: string) => {
    setIsOpen(false)
    await window.electronAPI?.switchModel?.(modelId, providerId)
    onModelChange(modelId, providerId)
  }

  // Find active model info
  const activePair = findActiveModelAndProvider(loadedProviders, currentModelId, currentProviderId)
  const legacyModel = getModelDef(currentModelId)
  const modelDisplayName = activePair?.model.name || legacyModel?.name || currentModelId || 'Select Model'

  const enabledGroups = getEnabledModelsGrouped(loadedProviders)

  return (
    <div className={`relative inline-block text-left ${className}`} ref={dropdownRef}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-neutral-600 hover:text-neutral-900 rounded-md hover:bg-neutral-100/90 transition-colors select-none"
      >
        <span className="truncate max-w-[150px]">{modelDisplayName}</span>
        <ChevronUp
          className={`w-3.5 h-3.5 text-neutral-400 transition-transform shrink-0 ${
            isOpen ? (dropDirection === 'up' ? 'rotate-180' : 'rotate-180') : ''
          }`}
        />
      </button>

      {isOpen && (
        <div
          className={`absolute left-0 ${
            dropDirection === 'up' ? 'bottom-full mb-2' : 'top-full mt-2'
          } w-80 rounded-xl bg-white border border-neutral-200/90 shadow-xl ring-1 ring-black/5 focus:outline-none z-50 max-h-[60vh] overflow-y-auto`}
        >
          <div className="p-1.5">
            {enabledGroups.length === 0 ? (
              <div className="p-4 text-center text-xs text-neutral-500">
                <p>未发现已启用的模型</p>
                {onOpenSettings && (
                  <button
                    type="button"
                    onClick={() => {
                      setIsOpen(false)
                      onOpenSettings()
                    }}
                    className="mt-2 text-blue-600 hover:underline font-medium"
                  >
                    前往设置配置供应商
                  </button>
                )}
              </div>
            ) : (
              enabledGroups.map(({ provider, models }) => (
                <div key={provider.id} className="mb-2 last:mb-0">
                  <div className="px-2.5 py-1 text-[11px] font-semibold text-neutral-400 uppercase tracking-wider flex items-center justify-between">
                    <span>{provider.name}</span>
                    <span className="text-[10px] lowercase font-normal text-neutral-400">
                      {provider.apiFormat.replace('_', ' ')}
                    </span>
                  </div>
                  {models.map((model: ModelItem) => {
                    const isSelected =
                      currentModelId === model.id &&
                      (!currentProviderId || currentProviderId === provider.id)
                    const isThinking = model.tags?.some((t) =>
                      ['thinking', '思考', 'r1', 'reasoning'].includes(t.toLowerCase())
                    )

                    return (
                      <button
                        key={model.id}
                        type="button"
                        onClick={() => handleSelect(model.id, provider.id)}
                        className={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs flex items-center justify-between transition-colors ${
                          isSelected
                            ? 'text-blue-600 bg-blue-50/80 font-medium'
                            : 'text-neutral-700 hover:bg-neutral-100/80'
                        }`}
                      >
                        <div className="flex items-center gap-1.5 truncate">
                          <span className="truncate">{model.name || model.id}</span>
                          {isThinking && (
                            <span title="Reasoning / Thinking model" className="text-[11px]">
                              💭
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5 text-[11px] shrink-0">
                          {model.tags && model.tags.length > 0 && (
                            <div className="flex items-center gap-1">
                              {model.tags.map((t) => (
                                <span
                                  key={t}
                                  className="px-1 py-0.5 rounded bg-neutral-100 text-neutral-500 font-mono text-[10px]"
                                >
                                  {t}
                                </span>
                              ))}
                            </div>
                          )}
                          {isSelected && <span className="text-blue-600 font-bold ml-0.5">✓</span>}
                        </div>
                      </button>
                    )
                  })}
                </div>
              ))
            )}

            {/* Quick config shortcut */}
            {onOpenSettings && (
              <div className="mt-1 pt-1.5 border-t border-neutral-100">
                <button
                  type="button"
                  onClick={() => {
                    setIsOpen(false)
                    onOpenSettings()
                  }}
                  className="w-full flex items-center justify-center gap-1.5 px-2.5 py-1.5 text-xs text-neutral-500 hover:text-neutral-900 hover:bg-neutral-50 rounded-lg transition-colors"
                >
                  <Settings className="w-3.5 h-3.5" />
                  <span>管理自定义模型供应商...</span>
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
