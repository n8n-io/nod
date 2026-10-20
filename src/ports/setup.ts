export interface SetupJournal {
  read<T>(section: string): Promise<T | undefined>;
  update<T>(section: string, change: (current: T | undefined) => T): Promise<T>;
}
