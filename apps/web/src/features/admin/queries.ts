import type {
  AdminDeviceWire, AdminSessionWire, AdminShareWire, AdminStatusWire, AdminUserWire, SsoSettingsInput, SsoSettingsWire,
  UnassignedFolder,
} from '@synclet/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { GroupWire, SpacePatch, SpaceWire } from './types';

export const ADMIN_KEY = ['admin'] as const;
/** `/sync/v1/account` (sidebar spaces, quota). */
const ACCOUNT_KEY = ['account'] as const;
const usersKey = [...ADMIN_KEY, 'users'] as const;
const userKey = (id: string) => [...usersKey, id] as const;
const sharesKey = [...ADMIN_KEY, 'shares'] as const;
const ssoKey = [...ADMIN_KEY, 'sso'] as const;

export const STATUS_REFRESH_MS = 30_000;

export interface CreateUserInput {
  username: string; displayName: string; email: string | null; password: string; role: 'admin' | 'user';
  adoptExistingFolder?: boolean;
}
export interface UserPatch {
  displayName?: string; email?: string | null; role?: 'admin' | 'user'; disabled?: boolean; password?: string;
}
export type ShareStatusFilter = 'active' | 'expired' | 'all';
export interface SsoTestResult { ok: boolean; issuer?: string; error?: string }

export function useAdminUsers() {
  return useQuery({ queryKey: usersKey, queryFn: () => api<AdminUserWire[]>('/admin/users') });
}

export function useUnassignedFolders(enabled: boolean) {
  return useQuery({
    queryKey: [...ADMIN_KEY, 'folders', 'unassigned'],
    queryFn: () => api<UnassignedFolder[]>('/admin/folders/unassigned'),
    enabled,
    staleTime: 0,
  });
}

export function useUserMutations() {
  const qc = useQueryClient();
  const settled = () => qc.invalidateQueries({ queryKey: ADMIN_KEY });
  return {
    create: useMutation({
      mutationFn: (input: CreateUserInput) => api<AdminUserWire>('/admin/users', { method: 'POST', json: input }),
      onSettled: settled,
    }),
    update: useMutation({
      mutationFn: (v: { id: string; patch: UserPatch }) => api<AdminUserWire>(`/admin/users/${v.id}`, { method: 'PATCH', json: v.patch }),
      onSettled: settled,
    }),
    remove: useMutation({
      mutationFn: (id: string) => api<void>(`/admin/users/${id}`, { method: 'DELETE' }),
      onSettled: settled,
    }),
  };
}

export function useUserSessions(id: string) {
  return useQuery({ queryKey: [...userKey(id), 'sessions'], queryFn: () => api<AdminSessionWire[]>(`/admin/users/${id}/sessions`) });
}

export function useUserDevices(id: string) {
  return useQuery({ queryKey: [...userKey(id), 'devices'], queryFn: () => api<AdminDeviceWire[]>(`/admin/users/${id}/devices`) });
}

export function useAccessMutations(userId: string) {
  const qc = useQueryClient();
  // Device counts live in the users list, so refresh it too.
  const settled = () => qc.invalidateQueries({ queryKey: usersKey });
  return {
    revokeSession: useMutation({
      mutationFn: (sessionId: string) => api<void>(`/admin/users/${userId}/sessions/${sessionId}`, { method: 'DELETE' }),
      onSettled: settled,
    }),
    revokeAllSessions: useMutation({
      mutationFn: () => api<void>(`/admin/users/${userId}/sessions`, { method: 'DELETE' }),
      onSettled: settled,
    }),
    revokeDevice: useMutation({
      mutationFn: (deviceId: string) => api<void>(`/admin/users/${userId}/devices/${deviceId}`, { method: 'DELETE' }),
      onSettled: settled,
    }),
  };
}

export function useAdminStatus() {
  return useQuery({
    queryKey: [...ADMIN_KEY, 'status'],
    queryFn: () => api<AdminStatusWire>('/admin/status'),
    refetchInterval: STATUS_REFRESH_MS,
  });
}

export function adminSharesPath(filter: { userId?: string; status: ShareStatusFilter }): string {
  const q = new URLSearchParams({ status: filter.status });
  if (filter.userId) q.set('userId', filter.userId);
  return `/admin/shares?${q}`;
}

export function useAdminShares(filter: { userId?: string; status: ShareStatusFilter }) {
  return useQuery({
    queryKey: [...sharesKey, filter.status, filter.userId ?? ''],
    queryFn: () => api<AdminShareWire[]>(adminSharesPath(filter)),
    placeholderData: (prev) => prev,
  });
}

export function useRevokeAnyShare() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/admin/shares/${id}`, { method: 'DELETE' }),
    // The owner's own list (`['shares']`) may show the same link.
    onSettled: () => Promise.all([qc.invalidateQueries({ queryKey: sharesKey }), qc.invalidateQueries({ queryKey: ['shares'] })]),
  });
}

export function useSsoSettings() {
  return useQuery({ queryKey: ssoKey, queryFn: () => api<SsoSettingsWire>('/admin/sso') });
}

export function useSsoMutations() {
  const qc = useQueryClient();
  return {
    save: useMutation({
      mutationFn: (input: SsoSettingsInput) => api<SsoSettingsWire>('/admin/sso', { method: 'PUT', json: input }),
      onSuccess: (saved) => qc.setQueryData(ssoKey, saved),
    }),
    test: useMutation({
      mutationFn: (issuer: string) => api<SsoTestResult>('/admin/sso/test', { method: 'POST', json: issuer.trim() ? { issuer: issuer.trim() } : {} }),
    }),
  };
}

// ---------------------------------------------------------------------------------------------
// Groups and spaces

const groupsKey = [...ADMIN_KEY, 'groups'] as const;
const spacesKey = [...ADMIN_KEY, 'spaces'] as const;

export function useAdminGroups() {
  return useQuery({ queryKey: groupsKey, queryFn: () => api<GroupWire[]>('/admin/groups') });
}

export function useGroupMutations() {
  const qc = useQueryClient();
  // Group membership shows up in spaces (via member names) too, and in the admin's own spaces.
  const settled = () => Promise.all([qc.invalidateQueries({ queryKey: ADMIN_KEY }), qc.invalidateQueries({ queryKey: ACCOUNT_KEY })]);
  return {
    create: useMutation({
      mutationFn: (input: { name: string; memberIds?: string[] }) => api<GroupWire>('/admin/groups', { method: 'POST', json: input }),
      onSettled: settled,
    }),
    update: useMutation({
      mutationFn: (v: { id: string; patch: { name?: string; memberIds?: string[] } }) =>
        api<GroupWire>(`/admin/groups/${v.id}`, { method: 'PATCH', json: v.patch }),
      onSettled: settled,
    }),
    remove: useMutation({
      mutationFn: (id: string) => api<void>(`/admin/groups/${id}`, { method: 'DELETE' }),
      onSettled: settled,
    }),
  };
}

export function useAdminSpaces() {
  return useQuery({ queryKey: spacesKey, queryFn: () => api<SpaceWire[]>('/admin/spaces') });
}

export function useSpaceMutations() {
  const qc = useQueryClient();
  // The admin may be a member: the sidebar's spaces (`/account`) change too.
  const settled = () => Promise.all([qc.invalidateQueries({ queryKey: ADMIN_KEY }), qc.invalidateQueries({ queryKey: ACCOUNT_KEY })]);
  return {
    create: useMutation({
      mutationFn: (input: { name: string; members?: SpacePatch['members'] }) => api<SpaceWire>('/admin/spaces', { method: 'POST', json: input }),
      onSettled: settled,
    }),
    update: useMutation({
      mutationFn: (v: { id: string; patch: SpacePatch }) => api<SpaceWire>(`/admin/spaces/${v.id}`, { method: 'PATCH', json: v.patch }),
      onSettled: settled,
    }),
    remove: useMutation({
      mutationFn: (id: string) => api<void>(`/admin/spaces/${id}`, { method: 'DELETE' }),
      onSettled: settled,
    }),
    restore: useMutation({
      mutationFn: (id: string) => api<SpaceWire>(`/admin/spaces/${id}/restore`, { method: 'POST' }),
      onSettled: settled,
    }),
    scan: useMutation({
      mutationFn: (id: string) => api<void>(`/admin/spaces/${id}/scan`, { method: 'POST' }),
      onSettled: settled,
    }),
  };
}
