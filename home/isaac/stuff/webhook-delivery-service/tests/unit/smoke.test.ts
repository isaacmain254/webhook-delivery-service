import { describe, it, expect } from 'vitest'

describe('smoke', () => {
  it('test framework is wired', () => {
    expect(true).toBe(true)
  })

  it('arithmetic works', () => {
    expect(1 + 1).toBe(2)
  })
})
