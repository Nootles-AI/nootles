# NML foundational decisions FAQ

Status: binding v1 decisions; reopen only by explicit architecture decision.

- **Inline Yjs encoding?** `Y.XmlFragment`/`Y.XmlText`; identified XML nodes for embeds.
- **Canonical text offset?** UTF-16 code units; UI operations cannot split graphemes.
- **Single-parent moves?** Stable node registry + parent/order placement; one elected placement.
- **Concurrent move winner?** Highest Lamport tuple `(clock, clientId)`; audit the loser.
- **Parent deleted during insert?** Put new subtree in hidden recovery root; never revive/drop.
- **Table columns identified?** Yes; stable column IDs in schema v1.
- **Canvas label text?** Inline subset: text, five marks, links; layout remains canvas data.
- **Album/storyboard/location v1?** Atomic typed props + read-only `legacyMarkup`.
- **PM translation?** Direct for text/marks/simple structure; subtree diff for complex steps.
- **Optimistic PM edits?** Show now; canonical commit wins; reconcile/rollback by request ID.
- **IME conflicts?** Buffer intersecting remote edits; deleted target enters recovery UI.
- **Canonical undo?** Origin-scoped `Y.UndoManager`; semantic inverses for review/restore only.
- **Typing undo group?** Same actor/kind/continuous selection within 750 ms; IME is one group.
- **AI hunk review?** Independent preconditioned command groups; checkpoint fallback on conflict.
- **Column resizing?** Block metadata keyed by stable column ID.
- **Canvas selection handoff?** NML node selection at PM atom; canvas owns internal selection.
- **Canvas deletion vs edit?** Delete visible block; preserve unseen scene edits in recovery.
- **Schema repair writer?** Backend only; clients diagnose/request, never race to repair.
- **Newer schema?** Whole document read-only; no normalization or downgrade write.
- **Initial limits?** 4 block levels; 10k blocks; 1M inline UTF-16 units; 25 MB domain payload.
