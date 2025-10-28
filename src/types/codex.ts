export type CodexCategory = 'character' | 'place' | 'item' | 'lore';

export interface CodexDetail {
  text: string;
  sourceSceneId?: string;
  createdAt: string;
}

export interface CodexEntry {
  id: string;
  name: string;
  category: CodexCategory;
  aliases: string[];
  summary: string;
  details: CodexDetail[];
  tags: string[];
}

export interface CodexState {
  entries: Record<string, CodexEntry>;
  selectedEntryId: string | null;
}
