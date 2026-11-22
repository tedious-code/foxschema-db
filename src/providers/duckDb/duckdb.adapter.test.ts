/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { coerceDriverBigint, duckDbAdapter } from './duckdb.adapter.js';

describe('coerceDriverBigint', () => {
  it('keeps safe integers as numbers', () => {
    expect(coerceDriverBigint(42n)).toBe(42);
    expect(coerceDriverBigint(BigInt(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('stringifies integers past MAX_SAFE_INTEGER so PK WHERE keys are not rounded', () => {
    const unsafe = 9007199254740993n; // Number(unsafe) === 9007199254740992
    expect(Number(unsafe)).toBe(9007199254740992);
    expect(Number.isSafeInteger(Number(unsafe))).toBe(false);
    expect(coerceDriverBigint(unsafe)).toBe('9007199254740993');
  });
});

describe('duckDbAdapter external-access lock', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fox-duckdb-lock-'));
  const secretFile = join(dir, 'secret.txt');
  const outFile = join(dir, 'out.csv');
  const dbFile = join(dir, 'user.duckdb');
  writeFileSync(secretFile, 'TOP_SECRET');

  afterAll(async () => {
    await duckDbAdapter.closeAll();
    rmSync(dir, { recursive: true, force: true });
  });

  it('blocks read_text, ATTACH, COPY TO, and re-enabling external access while allowing normal SQL and schema switching', async () => {
    const handle = await duckDbAdapter.acquire(dbFile, {}, false);
    await duckDbAdapter.query(handle, 'CREATE SCHEMA s1', []);
    await duckDbAdapter.setCurrentSchema(handle, 's1');
    await duckDbAdapter.query(handle, 'CREATE TABLE items (id INT, name VARCHAR)', []);
    await duckDbAdapter.query(handle, "INSERT INTO items VALUES (1, 'ok')", []);
    const rows = await duckDbAdapter.query<{ id: number; name: string }>(handle, 'SELECT id, name FROM items', []);
    expect(rows).toEqual([{ id: 1, name: 'ok' }]);

    await expect(
      duckDbAdapter.query(handle, `SELECT * FROM read_text('${secretFile.replace(/'/g, "''")}')`, []),
    ).rejects.toThrow(/file system operations are disabled|permission/i);
    await expect(
      duckDbAdapter.query(handle, `ATTACH '${join(dir, 'other.db').replace(/'/g, "''")}' AS m`, []),
    ).rejects.toThrow(/file system operations are disabled|permission/i);
    await expect(
      duckDbAdapter.query(handle, `COPY (SELECT 1) TO '${outFile.replace(/'/g, "''")}'`, []),
    ).rejects.toThrow(/file system operations are disabled|permission/i);
    await expect(
      duckDbAdapter.query(handle, 'SET enable_external_access = true', []),
    ).rejects.toThrow(/configuration has been locked/i);
  });

  it('refuses to open FoxSchema internal metadata database paths', async () => {
    await expect(duckDbAdapter.acquire(join(dir, 'foxschema.db'), {}, false)).rejects.toThrow(
      /internal metadata database/i,
    );
  });
});

describe('duckDbAdapter backup folder', () => {
  const root = mkdtempSync(join(tmpdir(), 'fox-duckdb-backup-'));
  const backups = join(root, 'backups');
  const outside = join(root, 'outside');
  const sq = (p: string) => `'${p.replace(/'/g, "''")}'`;
  const previous = process.env.FOX_DUCKDB_BACKUP_DIR;

  afterAll(async () => {
    if (previous === undefined) delete process.env.FOX_DUCKDB_BACKUP_DIR;
    else process.env.FOX_DUCKDB_BACKUP_DIR = previous;
    await duckDbAdapter.closeAll();
    rmSync(root, { recursive: true, force: true });
  });

  it('lets the Backup panel export into FOX_DUCKDB_BACKUP_DIR and nowhere else', async () => {
    mkdirSync(backups);
    mkdirSync(outside);
    process.env.FOX_DUCKDB_BACKUP_DIR = backups;
    const handle = await duckDbAdapter.acquire(join(root, 'data.duckdb'), {}, false);
    await duckDbAdapter.query(handle, 'CREATE TABLE t AS SELECT 1 AS x', []);

    // What the Backup panel runs: EXPORT DATABASE into a new folder inside it.
    await duckDbAdapter.query(handle, `EXPORT DATABASE ${sq(join(backups, 'b1'))} (FORMAT PARQUET)`, []);
    expect(existsSync(join(backups, 'b1', 't.parquet'))).toBe(true);

    const blocked = /file system operations are disabled|permission/i;
    await expect(
      duckDbAdapter.query(handle, `EXPORT DATABASE ${sq(join(outside, 'b2'))} (FORMAT PARQUET)`, []),
    ).rejects.toThrow(blocked);
    await expect(
      duckDbAdapter.query(handle, `EXPORT DATABASE ${sq(`${backups}/../outside/b3`)} (FORMAT PARQUET)`, []),
    ).rejects.toThrow(blocked);
    // A sibling whose name only starts like the folder is not inside it.
    mkdirSync(`${backups}-evil`);
    await expect(
      duckDbAdapter.query(handle, `EXPORT DATABASE ${sq(join(`${backups}-evil`, 'b4'))} (FORMAT PARQUET)`, []),
    ).rejects.toThrow(blocked);
    await expect(
      duckDbAdapter.query(handle, "SET allowed_directories = ['/']", []),
    ).rejects.toThrow(/configuration has been locked/i);
  });
});
