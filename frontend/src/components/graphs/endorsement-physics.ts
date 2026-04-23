import type { GraphEdge, GraphNode } from './physics';

export type NodeRole = 'center' | 'endorser' | 'target' | 'neutral';

export interface EndorsementRenderNode extends GraphNode {
  role?: NodeRole;
}

export interface EndorsementGraphEdge extends GraphEdge {
  suffixes: string[];
  weight: number;
  direction: 'incoming' | 'outgoing';
}

export interface EndorsementGraphData {
  nodes: EndorsementRenderNode[];
  edges: EndorsementGraphEdge[];
}

// Endorsement-specific colors
export const CENTER_COLOR = [78, 125, 247]; // primary blue
export const ENDORSER_COLOR = [120, 200, 130]; // green — incoming
export const TARGET_COLOR = [200, 140, 80]; // amber — outgoing
export const INCOMING_EDGE_COLOR = [80, 170, 100];
export const OUTGOING_EDGE_COLOR = [180, 120, 60];
