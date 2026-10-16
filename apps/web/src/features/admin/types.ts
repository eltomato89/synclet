// Wire formats of the Phase 4 admin API (groups and spaces); see the Task 5 contract.

export type SpaceRole = 'read' | 'write';

export interface GroupMemberWire { id: string; username: string; displayName: string }
export interface GroupWire { id: string; name: string; members: GroupMemberWire[] }

export interface SpaceMemberWire { kind: 'user' | 'group'; id: string; name: string; role: SpaceRole }
export interface SpaceWire {
  id: string;
  kind: 'team' | 'external';
  name: string;
  rootPath: string;
  status: 'available' | 'missing' | 'ignored';
  readOnly: boolean;
  watch: 'auto' | 'off' | null;
  scanIntervalSec: number | null;
  sizeBytes: number;
  itemCount: number;
  members: SpaceMemberWire[];
}
export interface SpacePatch {
  name?: string; watch?: 'auto' | 'off'; scanIntervalSec?: number | null;
  members?: { kind: 'user' | 'group'; id: string; role: SpaceRole }[];
}
