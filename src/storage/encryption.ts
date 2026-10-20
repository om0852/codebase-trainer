import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface EncryptedPayload {
  encrypted: true;
  algorithm: 'aes-256-gcm';
  iv: string;
  tag: string;
  data: string;
}

export class IndexEncryption {
  private static readonly ALGORITHM = 'aes-256-gcm';
  private static readonly KEY_LENGTH = 32; // 256 bits

  /**
   * Resolves or generates the local encryption key.
   * Checks CODEBASE_ENCRYPTION_KEY env var first, then .codebase/.master.key
   */
  public static getOrCreateKey(repoPath: string): Buffer {
    const envKey = process.env.CODEBASE_ENCRYPTION_KEY;
    if (envKey) {
      return crypto.createHash('sha256').update(envKey).digest();
    }

    const keyPath = path.join(repoPath, '.codebase', '.master.key');
    if (fs.existsSync(keyPath)) {
      try {
        const rawKey = fs.readFileSync(keyPath, 'utf8').trim();
        return Buffer.from(rawKey, 'hex');
      } catch {
        // fallback to generating new key
      }
    }

    // Generate secure random 256-bit key
    const newKey = crypto.randomBytes(this.KEY_LENGTH);
    const codebaseDir = path.dirname(keyPath);
    if (!fs.existsSync(codebaseDir)) {
      fs.mkdirSync(codebaseDir, { recursive: true });
    }
    fs.writeFileSync(keyPath, newKey.toString('hex'), { mode: 0o600, encoding: 'utf8' });
    return newKey;
  }

  public static encrypt(plainText: string, repoPath: string): EncryptedPayload {
    const key = this.getOrCreateKey(repoPath);
    const iv = crypto.randomBytes(12); // Standard 96-bit IV for GCM
    const cipher = crypto.createCipheriv(this.ALGORITHM, key, iv);

    let encrypted = cipher.update(plainText, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const tag = cipher.getAuthTag();

    return {
      encrypted: true,
      algorithm: this.ALGORITHM,
      iv: iv.toString('hex'),
      tag: tag.toString('hex'),
      data: encrypted
    };
  }

  public static decrypt(payload: EncryptedPayload, repoPath: string): string {
    const key = this.getOrCreateKey(repoPath);
    const iv = Buffer.from(payload.iv, 'hex');
    const tag = Buffer.from(payload.tag, 'hex');
    const decipher = crypto.createDecipheriv(this.ALGORITHM, key, iv);

    decipher.setAuthTag(tag);
    let decrypted = decipher.update(payload.data, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  public static isEncrypted(data: any): data is EncryptedPayload {
    return Boolean(data && typeof data === 'object' && data.encrypted === true && data.algorithm === 'aes-256-gcm');
  }
}
