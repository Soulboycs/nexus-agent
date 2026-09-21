import React from 'react'

/**
 * 保活容器(计划 §4.4):切 tab 时隐藏不卸载,流式/编辑器状态不丢。
 * 绝对定位叠放,active 决定可见性;始终渲染子树(Retained 语义)。
 */
export function RetainedPanel({
  active,
  children
}: {
  active: boolean
  children: React.ReactNode
}) {
  return (
    <div
      className="absolute inset-0 flex flex-col min-h-0 min-w-0"
      style={{ display: active ? 'flex' : 'none' }}
    >
      {children}
    </div>
  )
}
