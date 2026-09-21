// @vitest-environment happy-dom
/**
 * R7 判别 — ApprovalCard AskUserQuestion 渲染与 answers 回填（TM-R7-09 实测证据）。
 * 上一轮复核发现矩阵引用的组件用例不存在（虚报），本文件补齐。
 */
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent, screen } from '@testing-library/react'
import { ApprovalCard } from '../../src/renderer/src/components/ApprovalCard'
import { ApprovalRequest } from '../../src/shared/types'

const askRequest: ApprovalRequest = {
  id: 'req_ask',
  toolCallId: 'call_ask',
  toolName: 'AskUserQuestion',
  arguments: {
    questions: [
      {
        question: 'Which database should we use?',
        header: 'Database',
        options: [
          { label: 'SQLite', description: 'embedded' },
          { label: 'Postgres', description: 'server' },
        ],
      },
    ],
  },
  promptMessage: 'Tool "AskUserQuestion" requires your authorization.',
  timestamp: Date.now(),
}

describe('ApprovalCard — AskUserQuestion 选项渲染与 answers 回填', () => {
  it('渲染问题与全部选项；未全答时按钮禁用语义（文案提示）', () => {
    const onRespond = vi.fn()
    render(<ApprovalCard request={askRequest} onRespond={onRespond} />)
    expect(screen.getByText('Database')).toBeTruthy()
    expect(screen.getByText('Which database should we use?')).toBeTruthy()
    expect(screen.getByText('SQLite')).toBeTruthy()
    expect(screen.getByText('Postgres')).toBeTruthy()
    // 未作答时按钮文案是提示而非提交
    expect(screen.getByText('Answer all questions first')).toBeTruthy()
    expect(onRespond).not.toHaveBeenCalled()
  })

  it('选择选项 → Submit Answers → onRespond 携带完整原参数 + answers（整体替换语义兼容）', () => {
    const onRespond = vi.fn()
    render(<ApprovalCard request={askRequest} onRespond={onRespond} />)
    fireEvent.click(screen.getByText('Postgres'))
    fireEvent.click(screen.getByText('Submit Answers'))
    expect(onRespond).toHaveBeenCalledTimes(1)
    const [approved, , updatedInput] = onRespond.mock.calls[0]
    expect(approved).toBe(true)
    // 关键：updatedInput 必须携带 questions（引擎 updatedInput 为整体替换）
    expect((updatedInput as any).questions).toEqual(askRequest.arguments.questions)
    expect((updatedInput as any).answers).toEqual({ 'Which database should we use?': 'Postgres' })
  })
})
