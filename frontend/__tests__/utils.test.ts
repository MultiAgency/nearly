import {
  isValidHandle,
  sanitizeHandle,
  friendlyError,
} from '@/lib/utils';

describe('Utility Functions', () => {
  describe('isValidHandle', () => {
    it('validates correct handles', () => {
      expect(isValidHandle('agent123')).toBe(true);
      expect(isValidHandle('my_agent')).toBe(true);
      expect(isValidHandle('agent_bot')).toBe(true);
    });

    it('rejects invalid handles', () => {
      expect(isValidHandle('a')).toBe(false);
      expect(isValidHandle('agent-name')).toBe(false);
      expect(isValidHandle('agent name')).toBe(false);
      expect(isValidHandle('Agent_Bot')).toBe(false);
    });
  });

  describe('sanitizeHandle', () => {
    it('lowercases input', () => {
      expect(sanitizeHandle('MyAgent')).toBe('myagent');
    });

    it('strips invalid characters', () => {
      expect(sanitizeHandle('my-agent!@#')).toBe('myagent');
    });

    it('allows underscores and numbers', () => {
      expect(sanitizeHandle('agent_007')).toBe('agent_007');
    });

    it('returns empty string for all-invalid input', () => {
      expect(sanitizeHandle('---!!!')).toBe('');
    });

    it('strips unicode characters', () => {
      expect(sanitizeHandle('agénté')).toBe('agnt');
    });
  });

  describe('friendlyError', () => {
    it('maps timeout errors', () => {
      expect(friendlyError(new Error('Request abort'))).toContain('timed out');
    });

    it('maps network errors', () => {
      expect(friendlyError(new Error('fetch failed'))).toContain('NEAR network');
    });

    it('maps conflict errors', () => {
      expect(friendlyError(new Error('Handle already taken'))).toContain('already in use');
    });

    it('maps expired errors', () => {
      expect(friendlyError(new Error('timestamp expired'))).toContain('expired');
    });

    it('maps auth errors', () => {
      expect(friendlyError(new Error('401 unauthorized'))).toContain('Authentication');
    });

    it('returns generic message for unknown errors', () => {
      expect(friendlyError(new Error('something weird'))).toContain('Something went wrong');
    });

    it('handles non-Error objects', () => {
      expect(friendlyError('string error')).toContain('Something went wrong');
    });
  });
});
