import 'reflect-metadata';
import { expect, test } from 'bun:test';
import { Controller, Get, Injectable, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

@Injectable()
class ProbeService {
  message(): string { return 'ready'; }
}

@Controller('probe')
class ProbeController {
  constructor(private readonly service: ProbeService) {}

  @Get()
  read(): { status: string } { return { status: this.service.message() }; }
}

@Module({ controllers: [ProbeController], providers: [ProbeService] })
class ProbeModule {}

test('Bun runs Nest HTTP routing and constructor injection, then closes the server', async () => {
  const app = await NestFactory.create(ProbeModule, { logger: false });
  try {
    await app.listen(0, '127.0.0.1');
    const response = await fetch(`${await app.getUrl()}/probe`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ready' });
  } finally {
    await app.close();
  }
});
