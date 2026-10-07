import { describe, expect, it } from 'vitest'
import { redact } from './redact.js'
describe('凭证脱敏边界', () => {
  it('短的已知口令与带标签的短密码也会隐藏', () => {
    expect(redact('本地口令是 abcXYZ', ['abcXYZ'])).not.toContain('abcXYZ')
    expect(redact('本地口令是abcXYZ', ['abcXYZ'])).not.toContain('abcXYZ')
    expect(redact('password=12345', ['12345'])).not.toContain('12345')
    expect(redact('密码：a', ['a'])).not.toContain('：a')
  })
  it('短凭证边界不破坏普通正文，正则特殊字符按字面匹配', () => {
    expect(redact('table 已完成', ['a'])).toBe('table 已完成')
    expect(redact('口令为 a+b.', ['a+b.'])).toContain('[已隐藏凭证]')
    expect(redact('无凭证正文', [''])).toBe('无凭证正文')
  })
})
