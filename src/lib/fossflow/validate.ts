// Structural + cross-reference validation for FossFLOW models, mirroring the
// checks fossflow-lib runs on import (schemas + validateModel). Dependency-free
// so the topology-chat API can gate LLM patches before they reach the canvas.
type Row = Record<string, any>;

const isCoords = (c: any) => c && typeof c.x === 'number' && typeof c.y === 'number';

export function validateFossflowModel(m: any): string[] {
  const issues: string[] = [];
  if (!m || typeof m !== 'object') return ['model is not an object'];
  if (typeof m.title !== 'string') issues.push('title must be a string');
  for (const k of ['items', 'views', 'icons', 'colors']) {
    if (!Array.isArray(m[k])) issues.push(`${k} must be an array`);
  }
  if (issues.length) return issues;

  const iconIds = new Set(m.icons.map((i: Row) => i.id));
  const colorIds = new Set(m.colors.map((c: Row) => c.id));
  const itemIds = new Set<string>();

  m.icons.forEach((i: Row, idx: number) => {
    if (typeof i.id !== 'string' || typeof i.url !== 'string')
      issues.push(`icons[${idx}] needs id/url strings`);
  });
  m.colors.forEach((c: Row, idx: number) => {
    if (typeof c.id !== 'string' || typeof c.value !== 'string' || c.value.length > 7)
      issues.push(`colors[${idx}] needs id and a <=7-char color value`);
  });
  m.items.forEach((it: Row, idx: number) => {
    if (typeof it.id !== 'string' || typeof it.name !== 'string') {
      issues.push(`items[${idx}] needs id/name`);
      return;
    }
    if (itemIds.has(it.id)) issues.push(`duplicate item id: ${it.id}`);
    itemIds.add(it.id);
    if (it.icon !== undefined && !iconIds.has(it.icon))
      issues.push(`items[${idx}] (${it.id}) references missing icon: ${it.icon}`);
  });

  m.views.forEach((v: Row, vi: number) => {
    if (typeof v.id !== 'string' || !Array.isArray(v.items)) {
      issues.push(`views[${vi}] needs id and items[]`);
      return;
    }
    const viewItemIds = new Set<string>();
    v.items.forEach((it: Row, idx: number) => {
      if (typeof it.id !== 'string' || !isCoords(it.tile)) {
        issues.push(`views[${vi}].items[${idx}] needs id and tile {x,y}`);
        return;
      }
      viewItemIds.add(it.id);
      if (!itemIds.has(it.id))
        issues.push(`view item references missing model item: ${it.id}`);
    });
    (v.rectangles || []).forEach((r: Row, idx: number) => {
      if (!isCoords(r.from) || !isCoords(r.to))
        issues.push(`views[${vi}].rectangles[${idx}] needs from/to {x,y}`);
      if (r.color !== undefined && !colorIds.has(r.color))
        issues.push(`rectangle ${r.id || idx} references missing color: ${r.color}`);
    });
    (v.textBoxes || []).forEach((t: Row, idx: number) => {
      if (!isCoords(t.tile) || typeof t.content !== 'string')
        issues.push(`views[${vi}].textBoxes[${idx}] needs tile {x,y} and content`);
    });
    (v.connectors || []).forEach((c: Row, idx: number) => {
      if (!Array.isArray(c.anchors) || c.anchors.length < 2) {
        issues.push(`connector ${c.id || idx} needs >=2 anchors`);
        return;
      }
      if (c.color !== undefined && !colorIds.has(c.color))
        issues.push(`connector ${c.id || idx} references missing color: ${c.color}`);
      if (c.style !== undefined && !['SOLID', 'DOTTED', 'DASHED'].includes(c.style))
        issues.push(`connector ${c.id || idx} has invalid style: ${c.style}`);
      c.anchors.forEach((a: Row) => {
        const ref = a?.ref || {};
        const keys = Object.keys(ref);
        if (keys.length !== 1) {
          issues.push(`connector ${c.id || idx} anchors must have exactly one ref key`);
          return;
        }
        if (ref.item !== undefined && !viewItemIds.has(ref.item))
          issues.push(`connector ${c.id || idx} anchors a missing view item: ${ref.item}`);
        if (ref.tile !== undefined && !isCoords(ref.tile))
          issues.push(`connector ${c.id || idx} tile anchor needs {x,y}`);
      });
    });
  });
  return issues;
}
