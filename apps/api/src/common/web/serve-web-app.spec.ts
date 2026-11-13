import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import fs from 'node:fs';
import type { IncomingMessage } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import request from 'supertest';
import { apiCompression, carriesToken } from './compression.js';
import { pickEncoding, serveWebApp } from './serve-web-app.js';

const IMMUTABLE = 'public, max-age=31536000, immutable';

// Large enough to pass compression's 1 KB threshold.
const bigPayload = {
  items: Array.from({ length: 120 }, (_, i) => ({ id: i, code: `ITEM-${i}`, label: 'Compressible label text' })),
};

// Keeps the raw body as a Buffer instead of letting superagent parse it.
// superagent types its parser argument as its own Response, which is the
// Node IncomingMessage at runtime; the cast is the only bridge between them.
const binary = (res: unknown, done: (err: Error | null, body: Buffer) => void): void => {
  const stream = res as IncomingMessage;
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  stream.on('end', () => done(null, Buffer.concat(chunks)));
};

@Controller()
class TestController {
  @Get('big')
  big() {
    return bigPayload;
  }

  @Get('auth/big')
  authBig() {
    return bigPayload;
  }
}

@Module({ controllers: [TestController] })
class TestModule {}

describe('serveWebApp precompressed assets and API compression (WEB-11)', () => {
  const js = Array.from({ length: 200 }, (_, i) => `console.log("line ${i % 10}", ${i % 7});`).join('\n');
  const css = 'body { color: #111; margin: 0; }\n'.repeat(20);
  let tmpDir: string;
  let app: NestExpressApplication;

  beforeAll(async () => {
    // A dot-directory in the path, as in a checkout under .claude/: send() must still serve it.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), '.web-'));
    fs.writeFileSync(path.join(tmpDir, 'index.html'), '<!doctype html><title>app</title>');
    fs.mkdirSync(path.join(tmpDir, 'assets'));
    const jsBuffer = Buffer.from(js);
    fs.writeFileSync(path.join(tmpDir, 'assets', 'app-abc123.js'), jsBuffer);
    fs.writeFileSync(path.join(tmpDir, 'assets', 'app-abc123.js.br'), zlib.brotliCompressSync(jsBuffer));
    fs.writeFileSync(path.join(tmpDir, 'assets', 'app-abc123.js.gz'), zlib.gzipSync(jsBuffer));
    fs.writeFileSync(path.join(tmpDir, 'assets', 'plain-def456.css'), css);

    app = await NestFactory.create<NestExpressApplication>(TestModule, { logger: false });
    app.setGlobalPrefix('api/v1');
    app.use(apiCompression());
    // As in main.ts: CORS sets Vary: Origin before the web files are served.
    app.enableCors({ origin: 'http://app.test', credentials: true });
    serveWebApp(app, tmpDir);
    await app.init();
  });

  afterAll(async () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    await app.close();
  });

  const server = () => app.getHttpServer();

  it('serves the .br variant for a client that accepts br', async () => {
    const res = await request(server())
      .get('/assets/app-abc123.js')
      .set('Accept-Encoding', 'br, gzip')
      .buffer(true)
      .parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('br');
    expect(res.headers['vary']).toContain('Accept-Encoding');
    expect(res.headers['content-type']).toContain('javascript');
    expect(res.headers['cache-control']).toBe(IMMUTABLE);
    // superagent decodes br/gzip itself, so the body is the original bytes.
    expect(Buffer.compare(res.body as Buffer, Buffer.from(js))).toBe(0);
  });

  it('serves the .gz variant for a client that accepts only gzip', async () => {
    const res = await request(server())
      .get('/assets/app-abc123.js')
      .set('Accept-Encoding', 'gzip')
      .buffer(true)
      .parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.headers['vary']).toContain('Accept-Encoding');
    expect(Buffer.compare(res.body as Buffer, Buffer.from(js))).toBe(0);
  });

  it('falls back to gzip when br has q=0', async () => {
    const res = await request(server())
      .get('/assets/app-abc123.js')
      .set('Accept-Encoding', 'br;q=0, gzip')
      .buffer(true)
      .parse(binary);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(Buffer.compare(res.body as Buffer, Buffer.from(js))).toBe(0);
  });

  it('sends the original file with Vary when the client asks for identity', async () => {
    const res = await request(server())
      .get('/assets/app-abc123.js')
      .set('Accept-Encoding', 'identity')
      .buffer(true)
      .parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.headers['vary']).toContain('Accept-Encoding');
    expect(Buffer.compare(res.body as Buffer, Buffer.from(js))).toBe(0);
  });

  it("keeps CORS's Vary: Origin when it adds Accept-Encoding", async () => {
    for (const encoding of ['br', 'identity']) {
      const res = await request(server())
        .get('/assets/app-abc123.js')
        .set('Origin', 'http://app.test')
        .set('Accept-Encoding', encoding)
        .buffer(true)
        .parse(binary);
      const vary = String(res.headers['vary']).split(',').map((f) => f.trim());
      expect(vary).toEqual(expect.arrayContaining(['Origin', 'Accept-Encoding']));
    }
  });

  it('answers HEAD with the br variant headers', async () => {
    const res = await request(server()).head('/assets/app-abc123.js').set('Accept-Encoding', 'br, gzip');
    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('br');
  });

  it('does not use the precompressed path for a file without variants', async () => {
    const res = await request(server())
      .get('/assets/plain-def456.css')
      .set('Accept-Encoding', 'br')
      .buffer(true)
      .parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBeUndefined();
    // Under assets/, so the static rule (immutable) applies, as before.
    expect(res.headers['cache-control']).toBe(IMMUTABLE);
    expect(Buffer.compare(res.body as Buffer, Buffer.from(css))).toBe(0);
  });

  it('serves index.html with no-cache for an app route', async () => {
    const res = await request(server()).get('/sales');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<title>app</title>');
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('gzips API JSON when the client accepts gzip', async () => {
    const res = await request(server())
      .get('/api/v1/big')
      .set('Accept-Encoding', 'gzip')
      .buffer(true)
      .parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(JSON.parse((res.body as Buffer).toString('utf8'))).toEqual(bigPayload);
  });

  it('never compresses auth responses', async () => {
    const res = await request(server())
      .get('/api/v1/auth/big')
      .set('Accept-Encoding', 'gzip')
      .buffer(true)
      .parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(JSON.parse((res.body as Buffer).toString('utf8'))).toEqual(bigPayload);
  });
});

describe('pickEncoding', () => {
  const both = { br: true, gz: true };
  const gzOnly = { br: false, gz: true };

  it('prefers br when both variants are accepted', () => {
    expect(pickEncoding('br, gzip', both)).toBe('br');
    expect(pickEncoding('gzip, br', both)).toBe('br');
  });

  it('picks gzip when only gzip is accepted', () => {
    expect(pickEncoding('gzip', both)).toBe('gzip');
  });

  it('honours q=0', () => {
    expect(pickEncoding('br;q=0, gzip', both)).toBe('gzip');
    expect(pickEncoding('br;q=0', both)).toBeNull();
  });

  it('prefers the higher q-value', () => {
    expect(pickEncoding('br;q=0.5, gzip;q=0.9', both)).toBe('gzip');
  });

  it('matches tokens case-insensitively', () => {
    expect(pickEncoding('BR, GZIP', both)).toBe('br');
    expect(pickEncoding('Gzip', both)).toBe('gzip');
  });

  it('applies the * wildcard to encodings not listed', () => {
    expect(pickEncoding('*', both)).toBe('br');
    expect(pickEncoding('*;q=0', both)).toBeNull();
    expect(pickEncoding('gzip;q=0, *', both)).toBe('br');
  });

  it('returns null without a header or for identity only', () => {
    expect(pickEncoding(undefined, both)).toBeNull();
    expect(pickEncoding('', both)).toBeNull();
    expect(pickEncoding('identity', both)).toBeNull();
  });

  it('returns gzip when only gzip exists', () => {
    expect(pickEncoding('br, gzip', gzOnly)).toBe('gzip');
    expect(pickEncoding('br', gzOnly)).toBeNull();
  });
});

describe('carriesToken (no compression for token responses, WEB-11)', () => {
  it.each(['/api/v1/auth/login', '/api/v1/auth/register', '/api/v1/auth/refresh', '/api/v1/me/switch-tenant'])(
    'excludes %s',
    (p) => expect(carriesToken(p)).toBe(true),
  );

  it.each(['/api/v1/me', '/api/v1/accounts', '/api/v1/authority', '/assets/app.js'])('compresses %s', (p) =>
    expect(carriesToken(p)).toBe(false),
  );
});
