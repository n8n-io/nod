import type { PoolClient } from 'pg';

export interface AppGrantVault {
  put(id: string, value: string, client?: PoolClient, expiresAt?: Date | null): Promise<void>;
  read(id: string): Promise<{ value: string; version: number }>;
  replace(id: string, version: number, value: string): Promise<boolean>;
  remove(id: string, client?: PoolClient): Promise<void>;
  adoptPlain(id: string, value: string, expiresAt?: Date | null): Promise<void>;
}
