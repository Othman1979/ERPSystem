import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Env } from '../config/env.validation.js';

/**
 * Tenant files on the local disk (ADR-009 §7): STORAGE_DIR, outside the web
 * root. Keys are generated here only (`t<tenant>/<uuid>.<ext>`) and every
 * path is checked to stay inside the root.
 */
@Injectable()
export class StorageService {
  private readonly root: string;

  constructor(config: ConfigService<Env, true>) {
    this.root = path.resolve(config.get('STORAGE_DIR', { infer: true }));
  }

  private pathOf(key: string): string {
    const full = path.resolve(this.root, key);
    if (!full.startsWith(this.root + path.sep)) throw new Error(`Storage key outside the root: ${key}`);
    return full;
  }

  /** Writes the bytes and returns their storage key. */
  async save(tenantId: bigint, bytes: Buffer, extension: string): Promise<string> {
    const key = `t${tenantId}/${randomUUID()}.${extension}`;
    const full = this.pathOf(key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, bytes);
    return key;
  }

  read(key: string): Promise<Buffer> {
    return readFile(this.pathOf(key));
  }

  /** Removes a file; a missing one is not an error. */
  async remove(key: string): Promise<void> {
    await rm(this.pathOf(key), { force: true });
  }
}
