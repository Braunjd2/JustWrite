export function getNextOrder(items, getOrder) {
  if (!Array.isArray(items) || items.length === 0) {
    return 1;
  }
  return (
    items.reduce((max, item) => {
      if (!item) {
        return max;
      }
      const value = getOrder(item);
      const numeric = typeof value === 'number' && !Number.isNaN(value) ? value : 0;
      return numeric > max ? numeric : max;
    }, 0) + 1
  );
}

export function sortByOrder(list) {
  return [...list]
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const orderA =
        typeof a.item?.order === 'number' && !Number.isNaN(a.item.order) ? a.item.order : a.index + 1;
      const orderB =
        typeof b.item?.order === 'number' && !Number.isNaN(b.item.order) ? b.item.order : b.index + 1;
      if (orderA !== orderB) {
        return orderA - orderB;
      }
      return a.index - b.index;
    })
    .map((wrapper) => wrapper.item);
}

