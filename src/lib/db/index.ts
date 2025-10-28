import Dexie, { Table } from 'dexie';
import type { CodexEntry } from '../../types/codex';
import type { Scene } from '../../types/outline';

export interface SceneEntity {
  id?: number;
  sceneId: string;
  codexEntryId: string;
  role: 'mentioned' | 'focus' | 'pov';
}

export interface ActionLogEntry {
  id?: number;
  type: string;
  payload: unknown;
  timestamp: number;
}

export interface SettingsRecord {
  id: string;
  activeModel?: string;
  encryptedApiKeys?: Array<{ provider: string; value: string }>;
  preferences?: Record<string, unknown>;
}

export class SimpleWriterDatabase extends Dexie {
  codex!: Table<CodexEntry, string>;
  scenes!: Table<Scene, string>;
  sceneEntities!: Table<SceneEntity, number>;
  actions!: Table<ActionLogEntry, number>;
  settings!: Table<SettingsRecord, string>;

  constructor() {
    super('simplewriter');
    this.version(1).stores({
      codex: 'id,name,category',
      scenes: 'id,hash,chapterId,actId',
      sceneEntities: '++id,sceneId,codexEntryId',
      actions: '++id,timestamp',
      settings: 'id'
    });
  }
}

export const db = new SimpleWriterDatabase();
