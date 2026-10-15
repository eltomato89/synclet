import { describe, expect, it } from 'vitest';
import { contract } from '../src/context.js';
import { schemaErrors } from '../src/schema.js';

const { api } = contract();

// Guards the guard: the response validator must reject fields openapi.yaml does not document.
describe('schema validator', () => {
  it('rejects undocumented fields and wrong types', async () => {
    const root = (await api.get('/sync/v1/items/root')).json();
    expect(schemaErrors('SyncItem', root)).toBe('');
    expect(schemaErrors('SyncItem', { ...root, path: '/x' })).toMatch(/unevaluated/);
    expect(schemaErrors('SyncItem', { ...root, capabilities: { ...root.capabilities, share: true } })).toMatch(/unevaluated/);
    expect(schemaErrors('SyncItem', { ...root, size: '0' })).toMatch(/integer/);
    expect(schemaErrors('SyncChange', { op: 'delete', id: 'root', item: root })).not.toBe('');
  });
});
