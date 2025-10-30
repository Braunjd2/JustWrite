export function createId(prefix) {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${random}`;
}

export function nextActId(order) {
  return `A${order}`;
}

export function nextChapterId(actId, order) {
  return `${actId}.C${order}`;
}

export function nextSceneId(chapterId, order) {
  return `${chapterId}.S${order}`;
}

export function nextBeatId(sceneId, order) {
  return `${sceneId}.B${order}`;
}

