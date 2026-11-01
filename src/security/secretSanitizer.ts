export interface SanitizeResult {
  sanitizedText: string;
  redactedCount: number;
  detectedTypes: string[];
}

export class SecretSanitizer {
  /**
   * Sanitizes high-risk secrets, tokens, private keys, and passwords
   * in code chunks before saving to vector embeddings or context packs.
   */
  public static sanitizeContent(content: string): SanitizeResult {
    let sanitizedText = content;
    let redactedCount = 0;
    const detectedTypes: string[] = [];
    const secretRules = this.secretRules();

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

  /**
   * Names of the secret types present in a piece of text, without redacting it.
   */
  public static detectSecrets(text: string): string[] {
    return this.secretRules().filter(rule => rule.pattern.test(text)).map(rule => rule.name);
  }

  // Built fresh per call: the patterns are global regexes whose lastIndex must not leak between inputs
  private static secretRules(): Array<{ name: string; pattern: RegExp; replacement: string }> {
    return [
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
  }
}
