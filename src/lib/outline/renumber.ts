import type { Act, Chapter, Scene } from '../../types/outline';

export interface OutlineHierarchy {
  acts: Act[];
  chapters: Chapter[];
  scenes: Scene[];
}

export function renumberHierarchy(hierarchy: OutlineHierarchy): OutlineHierarchy {
  const acts = hierarchy.acts
    .sort((a, b) => a.order - b.order)
    .map((act, actIndex) => ({
      ...act,
      order: actIndex + 1
    }));

  const chapters = hierarchy.chapters.map((chapter) => {
    const parentAct = acts.find((act) => act.id === chapter.actId);
    const siblings = hierarchy.chapters
      .filter((c) => c.actId === chapter.actId)
      .sort((a, b) => a.order - b.order);
    const order = siblings.findIndex((c) => c.id === chapter.id) + 1;
    return {
      ...chapter,
      order,
      title: chapter.title || `Chapter ${parentAct ? parentAct.order : order}`
    };
  });

  const scenes = hierarchy.scenes.map((scene) => {
    const siblings = hierarchy.scenes
      .filter((s) => s.chapterId === scene.chapterId)
      .sort((a, b) => a.order - b.order);
    const order = siblings.findIndex((s) => s.id === scene.id) + 1;
    return {
      ...scene,
      order,
      title: scene.title || `Scene ${order}`
    };
  });

  return { acts, chapters, scenes };
}
