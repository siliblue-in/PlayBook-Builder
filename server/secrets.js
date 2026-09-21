// Encrypts provider credentials at rest (AES-256-GCM). The key lives in the
// local data folder; API responses only ever expose a masked form.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export class SecretBox {
  constructor(dataDir) {
    const keyFile = path.join(dataDir, '.secret.key');
    let key;
    try {
      key = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'hex');
    } catch {
      key = null;
    }
    if (!key || key.length !== 32) {
      key = crypto.randomBytes(32);
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(keyFile, key.toString('hex'), { encoding: 'utf8', mode: 0o600 });
    }
    this.key = key;
  }

  encrypt(plain) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ['v1', iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':');
  }

  decrypt(payload) {
    const [v, iv, tag, data] = String(payload || '').split(':');
    if (v !== 'v1') throw new Error('Unsupported secret format.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  }
}

export function maskSecret(secret) {
  const s = String(secret || '');
  if (s.length <= 10) return '••••';
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}
