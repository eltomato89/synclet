import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import type { IndexUser } from './types';

interface AppEventMap {
  'user.created': [IndexUser];
}

@Injectable()
export class AppEvents extends EventEmitter<AppEventMap> {}
