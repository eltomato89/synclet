import { Global, Module } from '@nestjs/common';
import { SpacesRepo } from './spaces.repo';

@Global()
@Module({ providers: [SpacesRepo], exports: [SpacesRepo] })
export class SpacesModule {}
