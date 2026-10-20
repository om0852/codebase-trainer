import * as fs from 'fs';
import * as path from 'path';

export interface SanitizeResult {
  sanitizedText: string;
  redactedCount: number;
  detectedTypes: string[];
}

export class SecretSanitizer {
  private static defaultIgnoredFiles = [
    '.env',
    '.env.local',
    '.env.development',
    '.env.production',
    '.env.test',
    '*.pem',
    '*.key',
    '*.pkcs12',
    '*.pfx',
    'id_rsa',
    'id_ed25519',
    'credentials.json',
    'serviceAccountKey.json',
    'client_secret*.json',
    '*.p8'
  ];

  /**
   * Loads user-defined ignore patterns from .codebaseignore if present,
   * plus standard enterprise credential ignore patterns.
   */
  public static loadIgnorePatterns(repoPath: string): string[] {
    const patterns = [...this.defaultIgnoredFiles];
    const ignoreFile = path.join(repoPath, '.codebaseignore');
    if (fs.existsSync(ignoreFile)) {
      try {
        const content = fs.readFileSync(ignoreFile, 'utf8');
        content
          .split(/\r?\n/)
          .map(line => line.trim())
          .filter(line => line && !line.startsWith('#'))
          .forEach(p => patterns.push(p));
      } catch {
        // ignore read error
      }
    }
    return patterns;
  }

  /**
   * Tests if a file path matches any .codebaseignore or secret file patterns.
   */
  public static isIgnoredFile(filePath: string, repoPath: string): boolean {
    const rel = path.relative(repoPath, filePath).replace(/\\/g, '/');
    const baseName = path.basename(filePath);
    const patterns = this.loadIgnorePatterns(repoPath);

    return patterns.some(pattern => {
      if (pattern.startsWith('*.')) {
        const ext = pattern.slice(1);
        return baseName.endsWith(ext);
      }
      if (pattern.endsWith('*')) {
        const prefix = pattern.slice(0, -1);
        return baseName.startsWith(prefix);
      }
      return rel === pattern || baseName === pattern || rel.includes('/' + pattern);
    });
  }

  /**
   * Sanitizes high-risk secrets, tokens, private keys, and passwords
   * in code chunks before saving to vector embeddings or context packs.
   */
  public static sanitizeContent(content: string): SanitizeResult {
    let sanitizedText = content;
    let redactedCount = 0;
    const detectedTypes: string[] = [];

    const secretRules: Array<{ name: string; pattern: RegExp; replacement: string }> = [
      {
        name: 'Private Key Block',
        pattern: /-----BEGIN\s+(?:RSA|OPENSSH|DSA|EC|PGP)?\s*PRIVATE KEY-----[\s\S]*?-----END\s+(?:RSA|OPENSSH|DSA|EC|PGP)?\s*PRIVATE KEY-----/gi,
        replacement: '/* [REDACTED_PRIVATE_KEY] */'
      },
      {
        name: 'Generic API Key / Secret Token',
        pattern: /(["']?(?:api[_-]?key|secret|token|auth[_-]?token|bearer|access[_-]?token)["']?\s*[:=]\s*["'])([a-zA-Z0-9_\-\.]{16,})(["'])/gi,
        replacement: '$1[REDACTED_API_TOKEN]$3'
      },
      {
        name: 'JWT Token',
        pattern: /\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/g,
        replacement: '[REDACTED_JWT_TOKEN]'
      },
      {
        name: 'AWS Access Key',
        pattern: /\b(AKIA|ABIA|ACCA|ASIA)[0-9A-Z]{16}\b/g,
        replacement: '[REDACTED_AWS_KEY]'
      },
      {
        name: 'Stripe Secret Key',
        pattern: /\b(?:sk|rk)_(?:live|test)_[0-9a-zA-Z]{24,}\b/g,
        replacement: '[REDACTED_STRIPE_KEY]'
      },
      {
        name: 'Database Connection String with Password',
        pattern: /(mongodb(?:\+srv)?|postgres|postgresql|mysql|redis):\/\/([^:]+):([^@]+)@/gi,
        replacement: '$1://$2:[REDACTED_PASSWORD]@'
      }
    ];

    for (const rule of secretRules) {
      if (rule.pattern.test(sanitizedText)) {
        detectedTypes.push(rule.name);
        sanitizedText = sanitizedText.replace(rule.pattern, (...args) => {
          redactedCount++;
          if (typeof rule.replacement === 'string') {
            return rule.replacement.replace(/\$1/g, args[1] || '').replace(/\$3/g, args[3] || '');
          }
          return '[REDACTED]';
        });
      }
    }

    return {
      sanitizedText,
      redactedCount,
      detectedTypes
    };
  }
}
