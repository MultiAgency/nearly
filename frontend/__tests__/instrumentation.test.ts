import { register } from '@/instrumentation';

const originalValue = process.env.NEARLY_DEPLOYMENT;

afterEach(() => {
  if (originalValue === undefined) {
    delete process.env.NEARLY_DEPLOYMENT;
  } else {
    process.env.NEARLY_DEPLOYMENT = originalValue;
  }
});

describe('instrumentation.register', () => {
  it('boots when NEARLY_DEPLOYMENT is unset', () => {
    delete process.env.NEARLY_DEPLOYMENT;
    expect(() => register()).not.toThrow();
  });

  it('boots when NEARLY_DEPLOYMENT is empty', () => {
    process.env.NEARLY_DEPLOYMENT = '';
    expect(() => register()).not.toThrow();
  });

  it("boots when NEARLY_DEPLOYMENT is 'single'", () => {
    process.env.NEARLY_DEPLOYMENT = 'single';
    expect(() => register()).not.toThrow();
  });

  it("throws naming nonceStore when NEARLY_DEPLOYMENT is 'multi'", () => {
    process.env.NEARLY_DEPLOYMENT = 'multi';
    expect(() => register()).toThrow(/nonceStore/);
  });

  it('throws with typo-guard listing allowed values on any other value', () => {
    process.env.NEARLY_DEPLOYMENT = 'asdf';
    expect(() => register()).toThrow(
      /not a recognized value.*unset.*single.*multi/,
    );
  });
});
