// Código de amigo: 6 caracteres com letras e números, sem ambiguidades (0/O, 1/I/L).
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

export function generateFriendCode(length = 6): string {
  let out = ''
  for (let i = 0; i < length; i++) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)]
  }
  return out
}