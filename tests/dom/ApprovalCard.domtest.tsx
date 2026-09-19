// @vitest-environment happy-dom
/**
 * P2b 审批卡交互测试（负向为主）：
 * - 非法 JSON 参数编辑必须拦截批准（不得发出 onRespond）
 * - 编辑后批准 → onRespond 携带 updatedInput
 * - 未改动参数 → 不发送 updatedInput（不误标 userModified）
 * - 拒绝流程带理由
 */
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent, screen } from '@testing-library/react'
import { ApprovalCard } from '../../src/renderer/src/components/ApprovalCard'
import { ApprovalRequest } from '../../src/shared/types'

const baseRequest: ApprovalRequest = {
  id: 'req_1',
  toolCallId: 'call_1',
  toolName: 'run_command',
  arguments: { command: 'echo original' },
  promptMessage: 'Tool "run_command" requires your authorization.',
  timestamp: Date.now(),
}

function setup(request: ApprovalRequest = baseRequest) {
  const onRespond = vi.fn()
  const utils = render(<ApprovalCard request={request} onRespond={onRespond} />)
  return { onRespond, ...utils }
}

describe('ApprovalCard — 参数编辑与审批（P2b）', () => {
  it('默认只读展示参数；不编辑直接批准 → onRespond(true) 且无 updatedInput', () => {
    const { onRespond } = setup()
    fireEvent.click(screen.getByText('Approve & Continue'))
    expect(onRespond).toHaveBeenCalledTimes(1)
    expect(onRespond).toHaveBeenCalledWith(true, undefined, undefined)
  })

  it('负向：编辑为非法 JSON → 批准被拦截，显示错误，不触发 onRespond', () => {
    const { onRespond } = setup()
    fireEvent.click(screen.getByText('Edit Parameters'))

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: '{broken json' } })
    fireEvent.click(screen.getByText('Approve & Continue'))

    expect(screen.getByText(/Invalid JSON/)).toBeTruthy()
    expect(onRespond).not.toHaveBeenCalled()
  })

  it('负向：编辑为非对象 JSON（数组/字面量）→ 同样拦截', () => {
    const { onRespond } = setup()
    fireEvent.click(screen.getByText('Edit Parameters'))
    const textarea = screen.getByRole('textbox')
    for (const bad of ['[1,2]', '"string"', '42']) {
      fireEvent.change(textarea, { target: { value: bad } })
      fireEvent.click(screen.getByText('Approve & Continue'))
      expect(onRespond).not.toHaveBeenCalled()
    }
  })

  it('编辑参数并批准 → onRespond 携带修改后的 updatedInput', () => {
    const { onRespond } = setup()
    fireEvent.click(screen.getByText('Edit Parameters'))
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: '{"command": "echo edited-by-user"}' } })
    fireEvent.click(screen.getByText('Approve & Continue'))

    expect(onRespond).toHaveBeenCalledTimes(1)
    const [approved, reason, updatedInput] = onRespond.mock.calls[0]
    expect(approved).toBe(true)
    expect(reason).toBeUndefined()
    expect(updatedInput).toEqual({ command: 'echo edited-by-user' })
  })

  it('打开编辑器但未改动 → 批准不发送 updatedInput（不得误标 userModified）', () => {
    const { onRespond } = setup()
    fireEvent.click(screen.getByText('Edit Parameters'))
    fireEvent.click(screen.getByText('Approve & Continue'))
    expect(onRespond).toHaveBeenCalledWith(true, undefined, undefined)
  })

  it('拒绝流程：Reject → 输入理由 → Confirm Reject 携带理由', () => {
    const { onRespond } = setup()
    fireEvent.click(screen.getByText('Reject...'))
    const input = screen.getByPlaceholderText(/Why is this action rejected/)
    fireEvent.change(input, { target: { value: 'Security concern' } })
    fireEvent.click(screen.getByText('Confirm Reject'))
    expect(onRespond).toHaveBeenCalledWith(false, 'Security concern')
  })
})
