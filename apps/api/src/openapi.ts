import {ApiBody} from '@nestjs/swagger';
import {z} from 'zod';
import {zodToJsonSchema} from 'zod-to-json-schema';
import type {SchemaObject} from '@nestjs/swagger/dist/interfaces/open-api-spec.interface.js';
export function ApiInput(schema:z.ZodTypeAny){const {$schema,...json}=zodToJsonSchema(schema,{$refStrategy:'none'});return ApiBody({schema:json as SchemaObject});}
