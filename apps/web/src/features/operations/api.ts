import type { CreateOperationRequest, ResolveOperationRequest, SyncOperation } from '@synclet/shared';
import { api } from '@/lib/api';

export const createOperation = (req: CreateOperationRequest) => api<SyncOperation>('/sync/v1/operations', { method: 'POST', json: req });
export const listActiveOperations = () => api<SyncOperation[]>('/sync/v1/operations?active=1');
export const getOperation = (id: string) => api<SyncOperation>(`/sync/v1/operations/${id}`);
export const resolveOperation = (id: string, body: ResolveOperationRequest) => api<SyncOperation>(`/sync/v1/operations/${id}/resolve`, { method: 'POST', json: body });
export const cancelOperation = (id: string) => api<SyncOperation>(`/sync/v1/operations/${id}/cancel`, { method: 'POST' });
export const isActive = (op: Pick<SyncOperation, 'status'>) => op.status === 'queued' || op.status === 'running' || op.status === 'waiting';
