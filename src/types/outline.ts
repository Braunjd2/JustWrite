export interface Beat {
  id: string;
  order: number;
  title: string;
}

export interface Scene {
  id: string;
  order: number;
  title: string;
  chapterId: string;
  actId: string;
  beats: Beat[];
  text: string;
  wordCount: number;
  draftStatus: 'empty' | 'drafted' | 'final';
  lastUpdated: string;
}

export interface Chapter {
  id: string;
  order: number;
  title: string;
  actId: string;
  sceneIds: string[];
}

export interface Act {
  id: string;
  order: number;
  title: string;
  chapterIds: string[];
}

export interface OutlineState {
  acts: Record<string, Act>;
  chapters: Record<string, Chapter>;
  scenes: Record<string, Scene>;
  selectedSceneId: string | null;
}
