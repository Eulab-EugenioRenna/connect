import 'reflect-metadata';
import {NestFactory} from '@nestjs/core';
import {AppModule,configureApp} from './app.js';
const app=await configureApp(await NestFactory.create(AppModule,{bodyParser:false}));
await app.listen(Number(process.env.PORT||3000),'0.0.0.0');
