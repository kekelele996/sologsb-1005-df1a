/**
 * 说明书正文指纹：比较只认规范化后的文字，忽略首尾空白、连续空白与全半角差异，
 * 这样客户改编号、调排版不会被误判为段落换过。
 */
export function normalizeText(text: string): string {
  return (text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ 　]+/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim()
}

/** 稳定的 32 位正文字纹（FNV-1a），不依赖 crypto，便于本机与测试环境使用。 */
export function checksum(text: string): string {
  const normalized = normalizeText(text)
  let hash = 0x811c9dc5
  for (let index = 0; index < normalized.length; index++) {
    hash ^= normalized.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
