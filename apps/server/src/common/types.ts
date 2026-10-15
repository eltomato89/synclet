export interface IndexUser {
  id: string;
  username: string;
}

export interface AuthUser extends IndexUser {
  role: 'admin' | 'user';
  /** Set when the request was authenticated with a device token. */
  deviceId: string | null;
}
