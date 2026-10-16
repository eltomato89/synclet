// Wire formats of the Phase 4 admin API (groups and spaces): the shared definitions, under the
// names the admin pages use.
import type { AdminGroupWire, AdminSpaceMemberInput, AdminSpaceMemberWire, AdminSpaceRole, AdminSpaceWire } from '@synclet/shared';

export type SpaceRole = AdminSpaceRole;
export type GroupWire = AdminGroupWire;
export type GroupMemberWire = AdminGroupWire['members'][number];
export type SpaceMemberWire = AdminSpaceMemberWire;
export type SpaceWire = AdminSpaceWire;
export interface SpacePatch {
  name?: string; watch?: 'auto' | 'off'; scanIntervalSec?: number | null;
  members?: AdminSpaceMemberInput[];
}
