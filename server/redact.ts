// 在写入数据库和发送模型前脱敏，日志只记录错误类别，不记录请求正文。
export function redact(text: string, secrets: string[] = []): string {
  let output = text
  for (const secret of secrets.filter((value) => value.length >= 8).sort((a, b) => b.length - a.length)) {
    output = output.split(secret).join('[已隐藏凭证]')
  }
  return output
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[已隐藏私钥]')
    .replace(/\b(?:sk-[\w-]{16,}|ark-[\w-]{20,})\b/g, '[已隐藏密钥]')
    // 旧会话可能把密码写入代码数组，保守隐藏独立短十六进制凭证；不修改64位来源ID。
    .replace(/\b[a-f0-9]{24,32}\b/gi, '[已隐藏凭证]')
    .replace(/(\b(?:postgres(?:ql)?|mysql):\/\/[^:\s/]+:)[^@\s]+(@)/gi, '$1[已隐藏密码]$2')
    .replace(/(\b(?:authorization\s*[:=]\s*(?:bearer\s+)?))[\w.+/=-]+/gi, '$1[已隐藏授权]')
    .replace(/((?:\b[\w-]*(?:api[_-]?key|password|passwd|secret|token)\b|密码|口令|密钥)[\s"'`*]*[:=|│：][\s"'`*]*)[^\s"'`|│,;]{6,}/gi, '$1[已隐藏凭证]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[已隐藏令牌]')
}
