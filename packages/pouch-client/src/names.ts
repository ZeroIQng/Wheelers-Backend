/**
 * Pouch rejects customer names that carry anything beyond plain letters —
 * emoji, symbols, decorative Unicode fonts. WhatsApp profile names carry all
 * three ("Timi 🔥", "𝓐𝓭𝓮", "✨Blessing✨"), and a rejected customer means no
 * virtual account, which means the user can never fund a wallet.
 *
 * The display name stays exactly as the user wrote it. Only what we hand to
 * Pouch is cleaned: NFKD folds fancy letters back to ASCII ("𝓐" → "A", "é" →
 * "e"), everything that is not a letter, apostrophe or hyphen becomes a space,
 * and whatever is left is split into first/last. Nothing usable → fallback.
 */
export interface PouchNameParts {
  firstName: string;
  lastName: string;
}

const MAX_PART_LENGTH = 50;

export function sanitizePouchName(value: string | null | undefined): string {
  if (!value) return '';
  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^A-Za-z'\-]+/g, ' ')
    .split(' ')
    .map((token) => token.replace(/^['-]+|['-]+$/g, ''))
    .filter((token) => /[A-Za-z]/.test(token))
    .map((token) => token.slice(0, MAX_PART_LENGTH))
    .join(' ');
}

export function pouchNameParts(
  displayName: string | null | undefined,
  fallback: PouchNameParts = { firstName: 'Wheelers', lastName: 'User' },
): PouchNameParts {
  const parts = sanitizePouchName(displayName).split(' ').filter(Boolean);
  if (parts.length === 0) return { ...fallback };
  const firstName = parts[0];
  const lastName = parts.slice(1).join(' ').slice(0, MAX_PART_LENGTH).trim() || fallback.lastName;
  return { firstName, lastName };
}
