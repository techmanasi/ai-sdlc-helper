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
