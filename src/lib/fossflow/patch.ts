// Minimal RFC 6902 JSON Patch applier (add / remove / replace) for FossFLOW
// model edits from the topology chat. Pure and dependency-free so it runs on
// both the API route (validation) and the client (application).
export interface PatchOp {
  op: 'add' | 'remove' | 'replace';
  path: string;
  value?: any;
}

function unescapeToken(t: string): string {
  return t.replace(/~1/g, '/').replace(/~0/g, '~');
}

function resolveParent(doc: any, path: string): { parent: any; key: string | number } {
  if (!path.startsWith('/')) throw new Error(`invalid path: ${path}`);
  const tokens = path.split('/').slice(1).map(unescapeToken);
  const last = tokens.pop() as string;
  let node = doc;
  for (const t of tokens) {
    const key: string | number = Array.isArray(node) ? Number(t) : t;
    node = node?.[key as any];
    if (node === undefined) throw new Error(`path not found: ${path}`);
  }
  if (Array.isArray(node)) {
    if (last === '-') return { parent: node, key: node.length };
    const idx = Number(last);
    if (!Number.isInteger(idx) || idx < 0) throw new Error(`bad array index in ${path}`);
    return { parent: node, key: idx };
  }
  if (node === null || typeof node !== 'object') throw new Error(`parent is not a container: ${path}`);
  return { parent: node, key: last };
}

export function applyPatch(doc: any, ops: PatchOp[]): any {
  const out = JSON.parse(JSON.stringify(doc));
  for (const o of ops) {
    const { parent, key } = resolveParent(out, o.path);
    if (o.op === 'add') {
      if (Array.isArray(parent)) parent.splice(Number(key), 0, o.value);
      else parent[key] = o.value;
    } else if (o.op === 'replace') {
      if (Array.isArray(parent) && Number(key) >= parent.length)
        throw new Error(`replace out of range: ${o.path}`);
      parent[key as any] = o.value;
    } else if (o.op === 'remove') {
      if (Array.isArray(parent)) {
        if (Number(key) >= parent.length) throw new Error(`remove out of range: ${o.path}`);
        parent.splice(Number(key), 1);
      } else {
        if (!(key in parent)) throw new Error(`remove missing key: ${o.path}`);
        delete parent[key];
      }
    } else {
      throw new Error(`unsupported op: ${(o as any).op}`);
    }
  }
  return out;
}
