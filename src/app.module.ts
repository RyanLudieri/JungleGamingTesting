import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { connectDatabase } from './shared/infrastructure/database';
import { ApiController, DATABASE, HttpErrors, NoopProviderGuard } from './shared/infrastructure/http';

@Module({controllers:[ApiController],providers:[
  {provide:DATABASE,useFactory:()=>connectDatabase(process.env.DATABASE_URL,process.env.DATABASE_SCHEMA??'public')},
  {provide:APP_FILTER,useClass:HttpErrors},{provide:APP_GUARD,useClass:NoopProviderGuard},
]})
export class AppModule {}
