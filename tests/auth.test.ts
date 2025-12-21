import { describe, it, expect } from 'vitest';
import {
  generateApiKey,
  hashApiKey,
  validateApiKey,
} from '../src/utils/auth';

describe('Auth utilities', () => {
  describe('generateApiKey', () => {
    it('should generate a 64-character hex string', () => {
      const key = generateApiKey();

      expect(key).toHaveLength(64);
      expect(/^[a-f0-9]+$/.test(key)).toBe(true);
    });

    it('should generate unique keys', () => {
      const keys = new Set<string>();
      for (let i = 0; i < 100; i++) {
        keys.add(generateApiKey());
      }

      expect(keys.size).toBe(100);
    });
  });

  describe('hashApiKey', () => {
    it('should produce consistent hashes', () => {
      const key = 'test-api-key';
      const hash1 = hashApiKey(key);
      const hash2 = hashApiKey(key);

      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different keys', () => {
      const hash1 = hashApiKey('key1');
      const hash2 = hashApiKey('key2');

      expect(hash1).not.toBe(hash2);
    });

    it('should produce 64-character hex hash', () => {
      const hash = hashApiKey('test');

      expect(hash).toHaveLength(64);
      expect(/^[a-f0-9]+$/.test(hash)).toBe(true);
    });
  });

  describe('validateApiKey', () => {
    it('should validate correct key', () => {
      const key = generateApiKey();
      const hash = hashApiKey(key);

      expect(validateApiKey(key, hash)).toBe(true);
    });

    it('should reject incorrect key', () => {
      const key = generateApiKey();
      const hash = hashApiKey(key);

      expect(validateApiKey('wrong-key', hash)).toBe(false);
    });

    it('should reject empty key', () => {
      const hash = hashApiKey('test');

      expect(validateApiKey('', hash)).toBe(false);
    });
  });
});
