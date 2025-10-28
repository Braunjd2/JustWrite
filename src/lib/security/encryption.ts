export async function encryptSecret(secret: string, keyMaterial: CryptoKey): Promise<ArrayBuffer> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(secret);
  const cipher = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv
    },
    keyMaterial,
    encoded
  );
  const buffer = new Uint8Array(iv.byteLength + cipher.byteLength);
  buffer.set(iv, 0);
  buffer.set(new Uint8Array(cipher), iv.byteLength);
  return buffer.buffer;
}

export async function decryptSecret(payload: ArrayBuffer, keyMaterial: CryptoKey): Promise<string> {
  const buffer = new Uint8Array(payload);
  const iv = buffer.slice(0, 12);
  const cipher = buffer.slice(12);
  const decoded = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv
    },
    keyMaterial,
    cipher
  );
  return new TextDecoder().decode(decoded);
}

export async function deriveKeyFromPassphrase(passphrase: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const salt = encoder.encode('simplewriter-key-salt');
  const baseKey = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: 120_000,
      hash: 'SHA-256'
    },
    baseKey,
    {
      name: 'AES-GCM',
      length: 256
    },
    false,
    ['encrypt', 'decrypt']
  );
}
