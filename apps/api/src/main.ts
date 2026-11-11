import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import { AppModule } from './app.module.js';
import { apiDocsEnabled, type Env } from './common/config/env.validation.js';
import { warnOnUntrustedProxy } from './common/web/proxy-warning.js';
import { serveWebApp } from './common/web/serve-web-app.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = app.get(ConfigService<Env, true>);
  const production = config.get('NODE_ENV', { infer: true }) === 'production';

  // Behind the host's proxy req.ip is the proxy's: count the hops so rate
  // limits and audit see the client (ADR-010 §10.1).
  const proxies = config.get('TRUST_PROXY', { infer: true });
  if (proxies > 0) app.set('trust proxy', proxies);
  else app.use(warnOnUntrustedProxy());
  // Close the database pool when the host restarts the app.
  app.enableShutdownHooks();

  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
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
      req.requestId = typeof incoming === 'string' && incoming.length > 0 ? incoming : randomUUID();
      next();
    },
  );

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
}

void bootstrap();
