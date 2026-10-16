export interface IndexUser {
  id: string;
  username: string;
}

/** A space as the file index and disk operations see it. Personal space: id = User.id. */
export interface IndexSpace {
  id: string;
  kind: 'personal' | 'team' | 'external';
  /** Absolute root folder of the space (in the container). */
  rootPath: string;
}

export interface AuthUser extends IndexUser {
  role: 'admin' | 'user';
  /** Set when the request was authenticated with a device token. */
  deviceId: string | null;
}
