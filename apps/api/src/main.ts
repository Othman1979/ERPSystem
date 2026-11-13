import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { AppModule } from './app.module.js';
import { apiDocsEnabled, trustProxySetting, type Env } from './common/config/env.validation.js';
import { redact } from './common/errors/error-events.util.js';
import { DocumentSizePipe } from './common/pipes/document-size.pipe.js';
import { IdParamPipe } from './common/pipes/id-param.pipe.js';
import { warnOnUntrustedProxy } from './common/web/proxy-warning.js';
import { serveWebApp } from './common/web/serve-web-app.js';

/** An incoming x-request-id is kept only if it is short and plain; otherwise a new UUID (PLAT-20). */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
/** JSON and form bodies: 2 MB (owner decision). Set here, not by Nest's default 100 kb parser. */
const BODY_LIMIT = '2mb';
/** Longer than a typical reverse-proxy idle timeout (60 s), so the proxy closes idle connections first (PLAT-29). */
const KEEP_ALIVE_TIMEOUT_MS = 65_000;
const HEADERS_TIMEOUT_MS = 66_000;
/** A stuck shutdown is cut off after this long (enableShutdownHooks closes Nest first). */
const FORCED_EXIT_MS = 15_000;

async function bootstrap(): Promise<void> {
  // bodyParser: false, so the 2 MB parsers below are the only ones: Nest would
  // otherwise register its own 100 kb parsers, which refuse bodies over 100 kb first.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  const config = app.get(ConfigService<Env, true>);
  const production = config.get('NODE_ENV', { infer: true }) === 'production';

  // req.ip is the client's address only behind the proxies named here (request limits, ADR-011).
  app.set('trust proxy', trustProxySetting(config.get('TRUST_PROXY', { infer: true })));
  // Forwarded requests from a proxy not named there: say so once (ADR-010 §10.1).
  app.use(warnOnUntrustedProxy());
  // Close the database pool when the host restarts the app.
  app.enableShutdownHooks();

  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new DocumentSizePipe(),
    new IdParamPipe(),
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.use(cookieParser());
  app.use(
    (req: { headers: Record<string, unknown>; requestId?: string }, _res: unknown, next: () => void) => {
      const incoming = req.headers['x-request-id'];
      req.requestId =
        typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming) ? incoming : randomUUID();
      next();
    },
  );
  // After the request id, so a body refused as too large still carries its requestId.
  app.useBodyParser('json', { limit: BODY_LIMIT });
  app.useBodyParser('urlencoded', { limit: BODY_LIMIT, extended: true });

  app.enableCors({
    origin: config.get('CORS_ORIGIN', { infer: true }),
    credentials: true,
  });

  // Helmet's defaults plus: item images are external https links; printed
  // documents open as blob: PDFs, whose page inherits this policy, and the
  // browser's PDF viewer is a plugin (object-src 'none' would show a blank
  // page); no framing at all; https upgrades only where there is https.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          'img-src': ["'self'", 'data:', 'blob:', 'https:'],
          'object-src': ['blob:'],
          'frame-ancestors': ["'none'"],
          'upgrade-insecure-requests': production ? [] : null,
        },
      },
    }),
  );

  const webDir = config.get('WEB_DIST_DIR', { infer: true });
  if (webDir) serveWebApp(app, webDir);

  if (apiDocsEnabled({ API_DOCS: config.get('API_DOCS', { infer: true }), NODE_ENV: config.get('NODE_ENV', { infer: true }) })) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('ERP Cloud API')
      .setDescription('Accounting & inventory SaaS API')
      .setVersion('0.1.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api/docs', app, document);
  }

  const port = config.get('API_PORT', { infer: true });
  await app.listen(port);

  // Behind a reverse proxy: keep idle connections longer than the proxy's own timeout (PLAT-29).
  const server = app.getHttpServer() as Server;
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;

  // enableShutdownHooks closes Nest on these signals; this timer ends the process if that stalls.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      setTimeout(() => process.exit(1), FORCED_EXIT_MS).unref();
    });
  }
}

bootstrap().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`API failed to start: ${redact(message)}`);
  process.exit(1);
});
