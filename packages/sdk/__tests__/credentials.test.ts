import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type CredentialsFile,
  loadCredentials,
  saveCredentials,
} from '../src/credentials';
import { NearlyError } from '../src/errors';

// Every case writes inside a fresh tmpdir — never touches ~/.config/nearly.
async function freshPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'nearly-creds-'));
  return join(dir, 'nested', 'credentials.json');
}

describe('credentials', () => {
  it('first write creates dir 0o700 and file 0o600', async () => {
    const path = await freshPath();
    await saveCredentials(
      { account_id: 'alice.near', api_key: 'wk_alice_1' },
      path,
    );

    const fileStat = await stat(path);
    expect(fileStat.mode & 0o777).toBe(0o600);

    const dirStat = await stat(join(path, '..'));
    // mkdir mode is masked by umask on some systems; assert group/other are
    // not writable at minimum.
    expect(dirStat.mode & 0o077).toBe(0);

    const parsed = JSON.parse(await readFile(path, 'utf8')) as CredentialsFile;
    expect(parsed.accounts['alice.near']).toEqual({
      account_id: 'alice.near',
      api_key: 'wk_alice_1',
    });
  });

  it('second write merges fields and preserves matching api_key', async () => {
    const path = await freshPath();
    await saveCredentials(
      { account_id: 'alice.near', api_key: 'wk_alice_1' },
      path,
    );
    await saveCredentials(
      {
        account_id: 'alice.near',
        api_key: 'wk_alice_1',
        platforms: { market: { handle: 'alice' } },
      },
      path,
    );

    const loaded = await loadCredentials(path);
    expect(loaded?.accounts['alice.near']).toMatchObject({
      account_id: 'alice.near',
      api_key: 'wk_alice_1',
      platforms: { market: { handle: 'alice' } },
    });
  });

  it('different api_key for same account_id throws VALIDATION_ERROR', async () => {
    const path = await freshPath();
    await saveCredentials(
      { account_id: 'alice.near', api_key: 'wk_alice_1' },
      path,
    );

    await expect(
      saveCredentials(
        { account_id: 'alice.near', api_key: 'wk_alice_2' },
        path,
      ),
    ).rejects.toMatchObject({
      name: 'NearlyError',
      shape: { code: 'VALIDATION_ERROR' },
    });
  });

  it('different account_id adds new entry alongside existing one', async () => {
    const path = await freshPath();
    await saveCredentials(
      { account_id: 'alice.near', api_key: 'wk_alice_1' },
      path,
    );
    await saveCredentials(
      { account_id: 'bob.near', api_key: 'wk_bob_1' },
      path,
    );

    const loaded = await loadCredentials(path);
    expect(Object.keys(loaded?.accounts ?? {})).toEqual(
      expect.arrayContaining(['alice.near', 'bob.near']),
    );
    expect(loaded?.accounts['alice.near']?.api_key).toBe('wk_alice_1');
    expect(loaded?.accounts['bob.near']?.api_key).toBe('wk_bob_1');
  });

  it('loadCredentials returns null on missing file', async () => {
    const path = await freshPath();
    const loaded = await loadCredentials(path);
    expect(loaded).toBeNull();
  });

  it('loadCredentials throws PROTOCOL on malformed JSON', async () => {
    const path = await freshPath();
    // Seed a broken file directly — bypass saveCredentials.
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
    await writeFile(path, '{not valid json', { mode: 0o600 });

    await expect(loadCredentials(path)).rejects.toBeInstanceOf(NearlyError);
    await expect(loadCredentials(path)).rejects.toMatchObject({
      shape: { code: 'PROTOCOL' },
    });
  });

  it('platforms sub-field merges rather than replacing', async () => {
    const path = await freshPath();
    await saveCredentials(
      {
        account_id: 'alice.near',
        api_key: 'wk_alice_1',
        platforms: { market: { handle: 'alice' } },
      },
      path,
    );
    await saveCredentials(
      {
        account_id: 'alice.near',
        api_key: 'wk_alice_1',
        platforms: { nearfm: { handle: 'alice.fm' } },
      },
      path,
    );

    const loaded = await loadCredentials(path);
    expect(loaded?.accounts['alice.near']?.platforms).toEqual({
      market: { handle: 'alice' },
      nearfm: { handle: 'alice.fm' },
    });
  });

  it('saveCredentials throws VALIDATION_ERROR when account_id is missing', async () => {
    const path = await freshPath();
    await expect(
      // Cast bypasses the TS guard so we can exercise the runtime check
      // — a caller constructing the arg from untyped JSON would hit this
      // path before any filesystem touch.
      saveCredentials(
        { api_key: 'wk_x' } as unknown as {
          account_id: string;
          api_key: string;
        },
        path,
      ),
    ).rejects.toMatchObject({
      name: 'NearlyError',
      shape: { code: 'VALIDATION_ERROR', field: 'account_id' },
    });
  });

  it('saveCredentials throws VALIDATION_ERROR when api_key is missing', async () => {
    const path = await freshPath();
    await expect(
      saveCredentials(
        { account_id: 'alice.near' } as unknown as {
          account_id: string;
          api_key: string;
        },
        path,
      ),
    ).rejects.toMatchObject({
      name: 'NearlyError',
      shape: { code: 'VALIDATION_ERROR', field: 'api_key' },
    });
  });

  it('loadCredentials throws PROTOCOL when top-level accounts is missing or malformed', async () => {
    const { mkdir } = await import('node:fs/promises');

    // Case 1: valid JSON but no `accounts` key at all.
    const path1 = await freshPath();
    await mkdir(join(path1, '..'), { recursive: true, mode: 0o700 });
    await writeFile(path1, JSON.stringify({ other: 'shape' }), { mode: 0o600 });
    await expect(loadCredentials(path1)).rejects.toMatchObject({
      name: 'NearlyError',
      shape: { code: 'PROTOCOL' },
    });

    // Case 2: `accounts` exists but is the wrong type (array instead of object).
    const path2 = await freshPath();
    await mkdir(join(path2, '..'), { recursive: true, mode: 0o700 });
    await writeFile(path2, JSON.stringify({ accounts: [] }), { mode: 0o600 });
    await expect(loadCredentials(path2)).rejects.toMatchObject({
      name: 'NearlyError',
      shape: { code: 'PROTOCOL' },
    });

    // Case 3: `accounts` exists but is null.
    const path3 = await freshPath();
    await mkdir(join(path3, '..'), { recursive: true, mode: 0o700 });
    await writeFile(path3, JSON.stringify({ accounts: null }), { mode: 0o600 });
    await expect(loadCredentials(path3)).rejects.toMatchObject({
      name: 'NearlyError',
      shape: { code: 'PROTOCOL' },
    });
  });

  it('unknown fields from existing file are preserved', async () => {
    const path = await freshPath();
    // Seed a file with a field credentials.ts does not know about.
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
    await writeFile(
      path,
      JSON.stringify({
        accounts: {
          'alice.near': {
            account_id: 'alice.near',
            api_key: 'wk_alice_1',
            future_field: { opaque: true },
          },
        },
      }),
      { mode: 0o600 },
    );

    await saveCredentials(
      {
        account_id: 'alice.near',
        api_key: 'wk_alice_1',
        platforms: { market: {} },
      },
      path,
    );

    const loaded = await loadCredentials(path);
    expect(loaded?.accounts['alice.near']).toMatchObject({
      future_field: { opaque: true },
      platforms: { market: {} },
    });
  });
});
