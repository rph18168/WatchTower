/** Plain-text chunks preserve supplementary characters at UTF-16 boundaries. */
export function splitText(text: string, limit: number): string[] {
  const parts: string[] = [];
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(offset + limit, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1]!)) end--;
    parts.push(text.slice(offset, end));
    offset = end;
  }
  return parts;
}
