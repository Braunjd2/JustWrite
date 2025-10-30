export function getOrderedSceneIds(appState) {
  if (!appState) {
    return [];
  }
  const orderedIds = [];
  const acts = [...(appState.acts || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
  acts.forEach((act) => {
    const chapters = (act?.chapterIds || [])
      .map((chapterId) => appState.chapters?.[chapterId])
      .filter(Boolean)
      .sort((a, b) => (a.order || 0) - (b.order || 0));
    chapters.forEach((chapter) => {
      const scenes = (chapter?.sceneIds || [])
        .map((sceneId) => appState.scenes?.[sceneId])
        .filter(Boolean)
        .sort((a, b) => (a.order || 0) - (b.order || 0));
      scenes.forEach((scene) => orderedIds.push(scene.id));
    });
  });
  return orderedIds;
}
