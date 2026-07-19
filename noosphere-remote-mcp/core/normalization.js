export function normalizeProjectText(value) {
  if (typeof value !== 'string') throw new Error('invalid-project-text');
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
}
