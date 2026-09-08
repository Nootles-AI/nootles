import type { Node as PmNode } from "prosemirror-model";

export type NodePositionEntry = {
  nodeId: string;
  pmStart: number;
  pmEnd: number;
  contentStart?: number;
  parentId: string | null;
  path: number[];
};
type Shard = { node: PmNode; start: number; index: number; entries: Map<string, NodePositionEntry> };

/** Untouched top-level subtrees retain their relative indexes; only their base moves. */
export class PositionIndex {
  private shards: Shard[] = [];
  private owners = new Map<string, Shard>();
  update(doc: PmNode): number {
    const previous = new Map(this.shards.map((shard) => [shard.node, shard]));
    const next: Shard[] = [];
    const owners = new Map<string, Shard>();
    let visited = 0;
    doc.forEach((node, start, index) => {
      let shard = previous.get(node);
      if (shard) shard = { ...shard, start, index };
      else {
        shard = { node, start, index, entries: new Map() };
        const entries = shard.entries;
        const visit = (child: PmNode, offset: number, parentId: string | null, path: number[]) => {
          visited++;
          const id = child.attrs.nmlId as string | undefined;
          if (id) {
            if (entries.has(id)) throw new Error("Duplicate projection identity");
            entries.set(id, { nodeId: id, pmStart: offset, pmEnd: offset + child.nodeSize, ...(child.isLeaf ? {} : { contentStart: offset + 1 }), parentId, path });
          }
          child.forEach((grandchild, position, i) => visit(grandchild, offset + 1 + position, id ?? parentId, [...path, i]));
        };
        visit(node, 0, null, []);
      }
      next.push(shard);
      for (const id of shard.entries.keys()) {
        if (owners.has(id)) throw new Error("Duplicate projection identity");
        owners.set(id, shard);
      }
    });
    this.shards = next;
    this.owners = owners;
    return visited;
  }
  get(nodeId: string): NodePositionEntry | undefined {
    const shard = this.owners.get(nodeId);
    const entry = shard?.entries.get(nodeId);
    return shard && entry ? { ...entry, pmStart: entry.pmStart + shard.start, pmEnd: entry.pmEnd + shard.start, ...(entry.contentStart === undefined ? {} : { contentStart: entry.contentStart + shard.start }), path: [shard.index, ...entry.path] } : undefined;
  }
  get byId(): ReadonlyMap<string, NodePositionEntry> { return new Map([...this.owners.keys()].map((id) => [id, this.get(id)!])); }
  nodeAt(position: number): NodePositionEntry | null {
    const shard = this.shards.find((entry) => position >= entry.start && position < entry.start + entry.node.nodeSize);
    if (!shard) return null;
    let found: NodePositionEntry | null = null;
    for (const entry of shard.entries.values()) {
      if (position >= shard.start + entry.pmStart && position < shard.start + entry.pmEnd && (!found || entry.path.length > found.path.length)) found = entry;
    }
    return found ? this.get(found.nodeId)! : null;
  }
}
