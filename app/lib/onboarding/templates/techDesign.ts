import type { Template } from "../types";
import { BOX, GHOST_BOX } from "../diagramStyle";

const ARCH = `<nt-diagram w="600" h="448">
  <nt-group id="g1" x="40" y="40" w="520" h="52" style="display: flex; gap: 17px">
    <nt-rect id="c1" w="162" h="52" style="${GHOST_BOX}">Web</nt-rect>
    <nt-rect id="c2" w="162" h="52" style="${GHOST_BOX}">Mobile</nt-rect>
    <nt-rect id="c3" w="162" h="52" style="${GHOST_BOX}">Partner API</nt-rect>
  </nt-group>
  <nt-rect id="gw" x="200" y="152" w="200" h="52" style="${BOX}">Edge gateway</nt-rect>
  <nt-rect id="rl" x="200" y="244" w="200" h="52" style="${BOX}">Rate limiter</nt-rect>
  <nt-rect id="st" x="440" y="244" w="120" h="52" style="${GHOST_BOX}">Redis</nt-rect>
  <nt-group id="g2" x="40" y="356" w="520" h="52" style="display: flex; gap: 17px">
    <nt-rect id="s1" w="162" h="52" style="${BOX}">Orders</nt-rect>
    <nt-rect id="s2" w="162" h="52" style="${BOX}">Catalog</nt-rect>
    <nt-rect id="s3" w="162" h="52" style="${BOX}">Search</nt-rect>
  </nt-group>
  <nt-edge id="e1" from="c2" to="gw"></nt-edge>
  <nt-edge id="e2" from="gw" to="rl"></nt-edge>
  <nt-edge id="e3" from="rl" to="st">counters</nt-edge>
  <nt-edge id="e4" from="rl" to="s2"></nt-edge>
</nt-diagram>`;

export const techDesign: Template = {
  id: "techDesign",
  label: "Technical design",
  blurb: "Context, a proposed shape, and the failure modes you can name now.",
  projectTitle: "Rate limiting",
  description: "Moving request limits out of each service and onto the edge.",
  roles: [
    "Software engineer",
    "Staff / principal engineer",
    "Engineering manager",
    "Architect",
    "SRE",
  ],
  pages: [
    {
      title: "Rate limiting",
      blocks: [
        { type: "heading", props: { level: 1 }, content: "Rate limiting" },
        {
          type: "paragraph",
          content:
            "Move request limits out of each service and onto the edge, so the answer to “how many requests is too many” is written in one place.",
        },
        { type: "heading", props: { level: 2 }, content: "Where we are" },
        {
          type: "paragraph",
          content:
            "Three services do their own counting. Two of them count in process memory, which means the limit is really the limit times the number of replicas, and nobody can say what that number is at any given moment.",
        },
        {
          id: "nt-tour-write",
          type: "paragraph",
          content: "The failure this produces is not obvious —",
        },
        { type: "heading", props: { level: 2 }, content: "Proposed shape" },
        {
          id: "nt-tour-draw",
          type: "paragraph",
          content: "The topology we would move to:",
        },
        { type: "heading", props: { level: 2 }, content: "Rollout" },
        {
          type: "bulletListItem",
          content: "Shadow mode: count, log, never reject.",
        },
        {
          type: "bulletListItem",
          content: "Enforce for partner traffic only, which is the noisiest.",
        },
        { type: "bulletListItem", content: "Enforce everywhere, per-route." },
      ],
    },
    {
      title: "Failure modes",
      blocks: [
        { type: "heading", props: { level: 1 }, content: "Failure modes" },
        {
          type: "paragraph",
          content:
            "What breaks when the limiter itself is the thing that is down.",
        },
      ],
    },
  ],
  script: {
    write: {
      blockId: "nt-tour-write",
      ghost:
        " a burst that clears the gateway can still flatten the service behind it.",
    },
    draw: {
      blockId: "nt-tour-draw",
      brief:
        "the request path from clients through the edge gateway and rate limiter to the services, with Redis holding the counters",
      html: ARCH,
    },
    ask: "Read this page, then write the token bucket check as a short TypeScript function in a code block.",
    suggest: {
      type: "codeBlock",
      label: "Code block",
      hint: "Thirteen languages, with real syntax highlighting.",
    },
  },
};
