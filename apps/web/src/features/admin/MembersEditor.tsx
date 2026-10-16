import { Users, X } from 'lucide-react';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { addMember, type MemberRow, memberKey, removeMember, setMemberRole } from './forms';
import type { SpaceRole } from './types';

export const SELECT_CLASS = 'h-8 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';

/** Members of a space: rows of group or user with a role, plus a picker for more. */
export function MembersEditor({ value, onChange, users, groups }: {
  value: MemberRow[];
  onChange(rows: MemberRow[]): void;
  users: { id: string; username: string; displayName: string }[];
  groups: { id: string; name: string }[];
}) {
  const { t } = useTranslation();
  const id = useId();
  const taken = new Set(value.map(memberKey));
  const freeGroups = groups.filter((g) => !taken.has(`group:${g.id}`));
  const freeUsers = users.filter((u) => !taken.has(`user:${u.id}`));

  function add(key: string) {
    const [kind, ...rest] = key.split(':');
    const mid = rest.join(':');
    if (kind === 'group') {
      const g = groups.find((x) => x.id === mid);
      if (g) onChange(addMember(value, { kind: 'group', id: g.id, name: g.name, role: 'read' }));
    } else if (kind === 'user') {
      const u = users.find((x) => x.id === mid);
      if (u) onChange(addMember(value, { kind: 'user', id: u.id, name: u.displayName, role: 'read' }));
    }
  }

  return (
    <div>
      <span id={`${id}-label`} className="mb-1.5 block text-sm font-medium text-foreground">{t('admin.spaces.members.title')}</span>
      {value.length === 0 ? (
        <p className="mb-2 text-xs text-muted-foreground">{t('admin.spaces.members.empty')}</p>
      ) : (
        <ul aria-labelledby={`${id}-label`} className="mb-2 divide-y rounded-lg border">
          {value.map((m) => (
            <li key={memberKey(m)} className="flex items-center gap-2 px-2.5 py-1.5">
              <Users className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-sm">
                <span className="font-medium">{m.name}</span>
                <span className="ml-1.5 text-xs text-muted-foreground">{t(`admin.spaces.members.kind.${m.kind}`)}</span>
              </span>
              <select
                aria-label={t('admin.spaces.members.roleFor', { name: m.name })}
                value={m.role}
                onChange={(e) => onChange(setMemberRole(value, memberKey(m), e.target.value as SpaceRole))}
                className={SELECT_CLASS}
              >
                <option value="read">{t('admin.spaces.members.role.read')}</option>
                <option value="write">{t('admin.spaces.members.role.write')}</option>
              </select>
              <Button
                type="button" variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-destructive"
                aria-label={t('admin.spaces.members.remove', { name: m.name })}
                onClick={() => onChange(removeMember(value, memberKey(m)))}
              >
                <X />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <select
        aria-label={t('admin.spaces.members.add')}
        value=""
        disabled={!freeGroups.length && !freeUsers.length}
        onChange={(e) => add(e.target.value)}
        className={`${SELECT_CLASS} w-full`}
      >
        <option value="">{t('admin.spaces.members.addPlaceholder')}</option>
        {freeGroups.length > 0 && (
          <optgroup label={t('admin.spaces.members.groups')}>
            {freeGroups.map((g) => <option key={g.id} value={`group:${g.id}`}>{g.name}</option>)}
          </optgroup>
        )}
        {freeUsers.length > 0 && (
          <optgroup label={t('admin.spaces.members.users')}>
            {freeUsers.map((u) => <option key={u.id} value={`user:${u.id}`}>{u.displayName}</option>)}
          </optgroup>
        )}
      </select>
    </div>
  );
}
