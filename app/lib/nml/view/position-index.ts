import type { Node as PmNode } from "prosemirror-model";

export type NodePositionEntry = {
  nodeId: string;
  pmStart: number;
  pmEnd: number;
  contentStart?: number;
  parentId: string | null;
  path: number[];
};

type Shard = {
  node: PmNode;
  index: number;
  entries: Map<string, NodePositionEntry>;
};

class FenwickTree {
  private tree: number[] = [0];

  rebuild(values: number[]): void {
    this.tree = Array(values.length + 1).fill(0);
    values.forEach((value, index) => this.add(index, value));
  }

  add(index: number, delta: number): void {
    for (let cursor = index + 1; cursor < this.tree.length; cursor += cursor & -cursor) this.tree[cursor] += delta;
  }

  prefix(index: number): number {
    let total = 0;
    for (let cursor = index; cursor > 0; cursor -= cursor & -cursor) total += this.tree[cursor];
    return total;
  }

  total(): number {
    return this.prefix(this.tree.length - 1);
  }

  indexAt(position: number): number {
    let index = 0;
    let total = 0;
    let bit = 1;
    while ((bit << 1) < this.tree.length) bit <<= 1;
    for (; bit; bit >>= 1) {
      const next = index + bit;
      if (next < this.tree.length && total + this.tree[next] <= position) {
        index = next;
        total += this.tree[next];
      }
    }
    return index;
  }
}

/** Untouched top-level subtrees retain their relative indexes and lazy prefix offsets. */
export class PositionIndex {
  private shards: Shard[] = [];
  private owners = new Map<string, Shard>();
  private sizes = new FenwickTree();

  private scan(node: PmNode, index: number): { shard: Shard; visited: number } {
    const entries = new Map<string, NodePositionEntry>();
    let visited = 0;
    const visit = (child: PmNode, offset: number, parentId: string | null, path: number[]) => {
      visited++;
      const id = child.attrs.nmlId as string | undefined;
      if (id) {
        if (entries.has(id)) throw new Error("Duplicate projection identity");
        entries.set(id, {
          nodeId: id,
          pmStart: offset,
          pmEnd: offset + child.nodeSize,
          ...(child.isLeaf ? {} : {
            contentStart: offset + 1 + (child.firstChild?.type.name === "inline_body" ? 1 : 0),
          }),
          parentId,
          path,
        });
      }
      child.forEach((grandchild, position, childIndex) => visit(grandchild, offset + 1 + position, id ?? parentId, [...path, childIndex]));
    };
    visit(node, 0, null, []);
    return { shard: { node, index, entries }, visited };
  }

  update(doc: PmNode): number {
    const previous = new Map(this.shards.map((shard) => [shard.node, shard]));
    const next: Shard[] = [];
    const owners = new Map<string, Shard>();
    let visited = 0;
    doc.forEach((node, _start, index) => {
      let shard = previous.get(node);
      if (shard) shard = { ...shard, index };
      else {
        const scanned = this.scan(node, index);
        shard = scanned.shard;
        visited += scanned.visited;
      }
      next.push(shard);
      for (const id of shard.entries.keys()) {
        if (owners.has(id)) throw new Error("Duplicate projection identity");
        owners.set(id, shard);
      }
    });
    this.shards = next;
    this.owners = owners;
    this.sizes.rebuild(next.map((shard) => shard.node.nodeSize));
    return visited;
  }

  /** Rescan only top-level shards containing changed text nodes. */
  updateChanged(nodeIds: readonly string[], doc: PmNode): number {
    const indexes = [...new Set(nodeIds.map((id) => this.owners.get(id)?.index).filter((index): index is number => index !== undefined))].sort((a, b) => a - b);
    let visited = 0;
    for (const index of indexes) {
      const previous = this.shards[index];
      const node = doc.child(index);
      const scanned = this.scan(node, index);
      visited += scanned.visited;
      for (const id of previous.entries.keys()) this.owners.delete(id);
      for (const id of scanned.shard.entries.keys()) {
        if (this.owners.has(id)) throw new Error("Duplicate projection identity");
        this.owners.set(id, scanned.shard);
      }
      this.shards[index] = scanned.shard;
      this.sizes.add(index, node.nodeSize - previous.node.nodeSize);
    }
    return visited;
  }

  get(nodeId: string): NodePositionEntry | undefined {
    const shard = this.owners.get(nodeId);
    const entry = shard?.entries.get(nodeId);
    if (!shard || !entry) return undefined;
    const start = this.sizes.prefix(shard.index);
    return {
      ...entry,
      pmStart: entry.pmStart + start,
      pmEnd: entry.pmEnd + start,
      ...(entry.contentStart === undefined ? {} : { contentStart: entry.contentStart + start }),
      path: [shard.index, ...entry.path],
    };
  }

  get byId(): ReadonlyMap<string, NodePositionEntry> {
    return new Map([...this.owners.keys()].map((id) => [id, this.get(id)!]));
  }

  nodeAt(position: number): NodePositionEntry | null {
    if (position < 0 || position >= this.sizes.total() || this.shards.length === 0) return null;
    const index = this.sizes.indexAt(position);
    const shard = this.shards[index];
    if (!shard) return null;
    const start = this.sizes.prefix(index);
    let found: NodePositionEntry | null = null;
    for (const entry of shard.entries.values()) {
      if (position >= start + entry.pmStart && position < start + entry.pmEnd && (!found || entry.path.length > found.path.length)) found = entry;
    }
    return found ? this.get(found.nodeId)! : null;
  }
}
