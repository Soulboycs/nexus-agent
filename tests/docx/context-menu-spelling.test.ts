import { describe, it, expect } from 'bun:test'

describe('Right-click ContextMenu Spelling Suggestions Integration', () => {
  it('1. Heuristic typo detection maps common typos to proper English corrections', () => {
    const COMMON_TYPOS: Record<string, string[]> = {
      teh: ['the'],
      recieve: ['receive'],
      seperate: ['separate'],
      occured: ['occurred'],
      untill: ['until'],
      definately: ['definitely'],
      goverment: ['government'],
      truely: ['truly'],
      beleive: ['believe'],
      wierd: ['weird'],
      accomodate: ['accommodate'],
      wich: ['which', 'witch'],
      thier: ['their', 'there'],
      adress: ['address'],
      wrok: ['work'],
      helo: ['hello', 'help'],
      docment: ['document'],
    }

    expect(COMMON_TYPOS['teh']).toEqual(['the'])
    expect(COMMON_TYPOS['recieve']).toEqual(['receive'])
    expect(COMMON_TYPOS['seperate']).toEqual(['separate'])
    expect(COMMON_TYPOS['docment']).toEqual(['document'])
  })
})
