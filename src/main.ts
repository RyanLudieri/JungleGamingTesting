import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

export async function bootstrap(): Promise<void> {
  const rawPort = process.env.PORT ?? '3000';
  if (!/^\d+$/.test(rawPort)) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  await app.listen(port);
}

if (import.meta.main) {
  bootstrap().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
