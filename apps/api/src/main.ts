import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import { AppModule } from './app.module.js';
import type { Env } from './common/config/env.validation.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService<Env, true>);

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

  app.use(helmet());

  const swaggerConfig = new DocumentBuilder()
    .setTitle('ERP Cloud API')
    .setDescription('Accounting & inventory SaaS API')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  const port = config.get('API_PORT', { infer: true });
  await app.listen(port);
}

void bootstrap();
