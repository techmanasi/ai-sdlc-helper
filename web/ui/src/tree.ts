export interface DocTreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: DocTreeNode[];
}

/**
 * Builds a hierarchical tree from a flat list of document paths.
 * Directory nodes sort before file nodes, and items at the same level sort alphabetically.
 */
export function buildDocTree(paths: string[]): DocTreeNode[] {
  interface InternalDirNode {
    name: string;
    path: string;
    isDir: boolean;
    children: Map<string, InternalDirNode>;
  }

  const root = new Map<string, InternalDirNode>();

  for (const rawPath of paths) {
    const cleanPath = rawPath.replace(/\\/g, '/').trim();
    if (!cleanPath) continue;
    const parts = cleanPath.split('/').filter(Boolean);
    if (!parts.length) continue;

    let currentMap = root;
    let currentPath = '';

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isDir = i < parts.length - 1;
      currentPath = currentPath ? `${currentPath}/${part}` : part;

      let node = currentMap.get(part);
      if (!node) {
        node = {
          name: part,
          path: isDir ? currentPath : rawPath,
          isDir,
          children: new Map(),
        };
        currentMap.set(part, node);
      } else if (isDir && !node.isDir) {
        node.isDir = true;
      }
      currentMap = node.children;
    }
  }

  function toList(map: Map<string, InternalDirNode>): DocTreeNode[] {
    const list: DocTreeNode[] = [];
    for (const node of map.values()) {
      list.push({
        name: node.name,
        path: node.path,
        isDir: node.isDir,
        children: toList(node.children),
      });
    }
    list.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return list;
  }

  return toList(root);
}

/** Recorded directory open/closed toggles: stage name, then directory path. */
export type StageDirState = Record<string, Record<string, boolean>>;

/** A directory starts open when it has at most one direct child, so single-child chains unfold on their own. */
export function defaultDirOpen(node: DocTreeNode): boolean {
  return node.children.length <= 1;
}

/** Whether a directory is open in a stage: the recorded value if there is one, otherwise the default. */
export function isStageDirOpen(state: StageDirState, stage: string, node: DocTreeNode): boolean {
  const recorded = state[stage]?.[node.path];
  return typeof recorded === 'boolean' ? recorded : defaultDirOpen(node);
}

/** Records a directory's state for a stage without mutating the input. Returns the same object if nothing changes. */
export function recordStageDir(state: StageDirState, stage: string, path: string, open: boolean): StageDirState {
  if (state[stage]?.[path] === open) return state;
  return { ...state, [stage]: { ...state[stage], [path]: open } };
}
