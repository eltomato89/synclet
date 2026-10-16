import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import type { IndexUser } from './types';

interface AppEventMap {
  'user.created': [IndexUser];
  /** Spaces were created, renamed, removed or changed status (watcher routes must be rebuilt). */
  'spaces.changed': [];
}

@Injectable()
export class AppEvents extends EventEmitter<AppEventMap> {}
