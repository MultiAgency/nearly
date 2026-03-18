import {
  cn,
  formatScore,
  formatRelativeTime,
  formatDate,
  formatDateTime,
  truncate,
  extractDomain,
  isValidAgentName,
  isValidSubmoltName,
  isValidApiKey,
  getInitials,
  pluralize,
  getPostUrl,
  getSubmoltUrl,
  getAgentUrl,
  debounce,
  randomId,
} from '@/lib/utils';

describe('Utility Functions', () => {
  describe('cn', () => {
    it('merges class names', () => {
      expect(cn('a', 'b')).toBe('a b');
    });

    it('handles conditional classes', () => {
      expect(cn('a', false && 'b', 'c')).toBe('a c');
    });

    it('merges tailwind classes correctly', () => {
      expect(cn('px-2', 'px-4')).toBe('px-4');
    });
  });

  describe('formatScore', () => {
    it('formats small numbers', () => {
      expect(formatScore(42)).toBe('42');
      expect(formatScore(999)).toBe('999');
    });

    it('formats thousands', () => {
      expect(formatScore(1000)).toBe('1K');
      expect(formatScore(1500)).toBe('1.5K');
      expect(formatScore(10000)).toBe('10K');
    });

    it('formats millions', () => {
      expect(formatScore(1000000)).toBe('1M');
      expect(formatScore(2500000)).toBe('2.5M');
    });

    it('handles negative numbers', () => {
      expect(formatScore(-100)).toBe('-100');
      expect(formatScore(-1500)).toBe('-1.5K');
    });
  });

  describe('truncate', () => {
    it('returns original string if short enough', () => {
      expect(truncate('hello', 10)).toBe('hello');
    });

    it('truncates long strings', () => {
      expect(truncate('hello world', 8)).toBe('hello...');
    });
  });

  describe('extractDomain', () => {
    it('extracts domain from URL', () => {
      expect(extractDomain('https://www.example.com/path')).toBe('example.com');
      expect(extractDomain('https://sub.example.com')).toBe('sub.example.com');
    });

    it('returns null for invalid URLs', () => {
      expect(extractDomain('not a url')).toBeNull();
    });
  });

  describe('isValidAgentName', () => {
    it('validates correct names', () => {
      expect(isValidAgentName('agent123')).toBe(true);
      expect(isValidAgentName('my_agent')).toBe(true);
      expect(isValidAgentName('Agent_Bot')).toBe(true);
    });

    it('rejects invalid names', () => {
      expect(isValidAgentName('a')).toBe(false); // too short
      expect(isValidAgentName('agent-name')).toBe(false); // invalid char
      expect(isValidAgentName('agent name')).toBe(false); // space
    });
  });

  describe('isValidSubmoltName', () => {
    it('validates correct names', () => {
      expect(isValidSubmoltName('general')).toBe(true);
      expect(isValidSubmoltName('my_community')).toBe(true);
    });

    it('rejects invalid names', () => {
      expect(isValidSubmoltName('x')).toBe(false); // too short
      expect(isValidSubmoltName('Invalid')).toBe(false); // uppercase
    });
  });

  describe('isValidApiKey', () => {
    it('validates correct API keys', () => {
      expect(isValidApiKey('moltbook_abcdefghij1234567890')).toBe(true); // exactly 20 chars
      expect(isValidApiKey('moltbook_' + 'a'.repeat(64))).toBe(true); // 64 chars (real key length)
    });

    it('rejects invalid API keys', () => {
      expect(isValidApiKey('invalid_key')).toBe(false);
      expect(isValidApiKey('moltbook_short')).toBe(false);
      expect(isValidApiKey('moltbook_abcdefghij123456789')).toBe(false); // 19 chars — boundary
    });
  });

  describe('getInitials', () => {
    it('gets initials from name', () => {
      expect(getInitials('John Doe')).toBe('JD');
      expect(getInitials('my_agent')).toBe('MA');
      expect(getInitials('single')).toBe('S');
    });
  });

  describe('pluralize', () => {
    it('returns singular for 1', () => {
      expect(pluralize(1, 'comment')).toBe('comment');
    });

    it('returns plural for other numbers', () => {
      expect(pluralize(0, 'comment')).toBe('comments');
      expect(pluralize(5, 'comment')).toBe('comments');
    });

    it('uses custom plural', () => {
      expect(pluralize(2, 'person', 'people')).toBe('people');
    });
  });

  describe('URL helpers', () => {
    it('generates correct URLs', () => {
      expect(getPostUrl('123', 'general')).toBe('/m/general/post/123');
      expect(getPostUrl('123')).toBe('/post/123');
      expect(getSubmoltUrl('general')).toBe('/m/general');
      expect(getAgentUrl('bot')).toBe('/u/bot');
    });
  });

  describe('formatScore edge cases', () => {
    it('formats 10M+', () => {
      expect(formatScore(15000000)).toBe('15M');
    });
  });

  describe('truncate edge cases', () => {
    it('handles empty string', () => {
      expect(truncate('', 10)).toBe('');
    });

    it('handles exact length', () => {
      expect(truncate('hello', 5)).toBe('hello');
    });
  });

  describe('formatRelativeTime', () => {
    it('formats recent dates', () => {
      const recent = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      expect(formatRelativeTime(recent)).toContain('minutes ago');
    });

    it('accepts Date objects', () => {
      const d = new Date(Date.now() - 60 * 60 * 1000);
      expect(formatRelativeTime(d)).toContain('hour');
    });
  });

  describe('formatDate', () => {
    it('formats ISO string to readable date', () => {
      const result = formatDate('2025-03-15T12:00:00Z');
      expect(result).toContain('2025');
      expect(result).toContain('Mar');
    });
  });

  describe('formatDateTime', () => {
    it('includes both date and time', () => {
      const result = formatDateTime('2025-03-15T14:30:00Z');
      expect(result).toContain('2025');
      expect(result).toMatch(/\d{1,2}:\d{2}/);
    });
  });

  describe('randomId', () => {
    it('returns string of requested length', () => {
      expect(randomId(8)).toHaveLength(8);
      expect(randomId(16)).toHaveLength(16);
    });

    it('generates unique values', () => {
      const ids = new Set(Array.from({ length: 50 }, () => randomId()));
      expect(ids.size).toBe(50);
    });
  });

  describe('debounce', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('delays execution', () => {
      const fn = jest.fn();
      const debounced = debounce(fn, 100);

      debounced();
      expect(fn).not.toHaveBeenCalled();

      jest.advanceTimersByTime(100);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('resets timer on subsequent calls', () => {
      const fn = jest.fn();
      const debounced = debounce(fn, 100);

      debounced();
      jest.advanceTimersByTime(50);
      debounced();
      jest.advanceTimersByTime(50);
      expect(fn).not.toHaveBeenCalled();

      jest.advanceTimersByTime(50);
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });
});
