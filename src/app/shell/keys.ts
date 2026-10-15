/** True if a keyboard event comes from a text field, where shortcuts shouldn't fire. */
export function isTyping(e: Event): boolean {
  const t = e.target;
  return t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));
}
