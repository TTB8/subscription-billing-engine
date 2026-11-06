import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { ConfigError, loadConfig } from './config/env';
import { setupApp } from './setup-app';

async function bootstrap(): Promise<void> {
  let port: number;
  try {
    port = loadConfig().port;
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  // rawBody: signature verification needs the exact bytes Stripe sent.
  const app = await NestFactory.create(AppModule, { rawBody: true });
  setupApp(app);

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Subscription Billing Engine')
      .setDescription(
        'Fixed-cycle subscriptions, prepaid terms, dunning and idempotent Stripe webhooks.',
      )
      .setVersion('0.1.0')
      .build(),
  );
  SwaggerModule.setup('docs', app, document);

  await app.listen(port);
  new Logger('Bootstrap').log(`Listening on :${port}, API docs at /docs`);
}

void bootstrap();
