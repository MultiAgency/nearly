'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';
import {
  CENTER_COLOR,
  ENDORSER_COLOR,
  type EndorsementGraphData,
  type EndorsementGraphEdge,
  type EndorsementRenderNode,
  INCOMING_EDGE_COLOR,
  OUTGOING_EDGE_COLOR,
  TARGET_COLOR,
} from './endorsement-physics';
import {
  applyForces,
  buildAdjacency,
  hitTestNode,
  type Pulse,
  rgba,
  updatePulses,
} from './physics';

function nodeColor(node: EndorsementRenderNode): number[] {
  switch (node.role) {
    case 'center':
      return CENTER_COLOR;
    case 'endorser':
      return ENDORSER_COLOR;
    case 'target':
      return TARGET_COLOR;
    default:
      return CENTER_COLOR;
  }
}

function edgeColor(edge: EndorsementGraphEdge): number[] {
  return edge.direction === 'incoming'
    ? INCOMING_EDGE_COLOR
    : OUTGOING_EDGE_COLOR;
}

export function BaseEndorsementGraph({
  graphData,
  ariaLabel,
}: {
  graphData: EndorsementGraphData;
  ariaLabel: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const hoverRef = useRef<string | null>(null);
  const router = useRouter();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || graphData.nodes.length === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const prefersReducedMotion = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches;

    let w = 0;
    let h = 0;
    const dpr = window.devicePixelRatio || 1;

    const nodes: EndorsementRenderNode[] = graphData.nodes.map((n) => ({
      ...n,
    }));
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));
    const edges: EndorsementGraphEdge[] = graphData.edges.filter(
      (e) => nodeMap.has(e.from) && nodeMap.has(e.to),
    );
    const adjacency = buildAdjacency(edges);
    const pulses: Pulse[] = [];
    const pulseTimer = { value: 0 };
    let initialized = false;

    function resize() {
      const rect = canvas!.getBoundingClientRect();
      w = rect.width;
      h = rect.height;
      canvas!.width = w * dpr;
      canvas!.height = h * dpr;
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (!initialized) {
        for (const node of nodes) {
          node.x *= w;
          node.y *= h;
        }
        initialized = true;
      }
    }

    function handleMouseMove(e: MouseEvent) {
      const rect = canvas!.getBoundingClientRect();
      hoverRef.current = hitTestNode(
        nodes,
        e.clientX - rect.left,
        e.clientY - rect.top,
      );
      canvas!.style.cursor = hoverRef.current ? 'pointer' : 'default';
    }

    function handleMouseLeave() {
      hoverRef.current = null;
      canvas!.style.cursor = 'default';
    }

    function handleClick(e: MouseEvent) {
      const rect = canvas!.getBoundingClientRect();
      const id = hitTestNode(
        nodes,
        e.clientX - rect.left,
        e.clientY - rect.top,
      );
      if (id) router.push(`/agents/${encodeURIComponent(id)}`);
    }

    canvas.addEventListener('mousemove', handleMouseMove);
    canvas.addEventListener('mouseleave', handleMouseLeave);
    canvas.addEventListener('click', handleClick);

    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    function draw() {
      ctx!.clearRect(0, 0, w, h);
      const hoverId = hoverRef.current;
      const neighbors = hoverId ? (adjacency.get(hoverId) ?? null) : null;
      const hasHover = hoverId !== null;

      // Edges
      for (const edge of edges) {
        const from = nodeMap.get(edge.from);
        const to = nodeMap.get(edge.to);
        if (!from || !to) continue;
        const highlighted =
          hasHover && (edge.from === hoverId || edge.to === hoverId);
        const alpha = hasHover ? (highlighted ? 0.6 : 0.05) : 0.25;
        ctx!.strokeStyle = rgba(edgeColor(edge), alpha);
        ctx!.lineWidth =
          Math.min(edge.weight * 1.5, 5) * (highlighted ? 1.5 : 1);
        ctx!.beginPath();
        ctx!.moveTo(from.x, from.y);
        ctx!.lineTo(to.x, to.y);
        ctx!.stroke();
      }

      // Pulses
      for (const pulse of pulses) {
        const from = nodeMap.get(pulse.edge.from);
        const to = nodeMap.get(pulse.edge.to);
        if (!from || !to) continue;
        const px = from.x + (to.x - from.x) * pulse.progress;
        const py = from.y + (to.y - from.y) * pulse.progress;
        const glow = ctx!.createRadialGradient(px, py, 0, px, py, 8);
        glow.addColorStop(0, rgba(CENTER_COLOR, 0.8));
        glow.addColorStop(1, rgba(CENTER_COLOR, 0));
        ctx!.fillStyle = glow;
        ctx!.beginPath();
        ctx!.arc(px, py, 8, 0, Math.PI * 2);
        ctx!.fill();
      }

      // Nodes
      for (const node of nodes) {
        const isHovered = hoverId === node.id;
        const isNeighbor = neighbors?.has(node.id) ?? false;
        const dimmed = hasHover && !isHovered && !isNeighbor;
        const color = nodeColor(node);

        // Glow
        const glowAlpha = dimmed ? 0.05 : 0.3;
        const glow = ctx!.createRadialGradient(
          node.x,
          node.y,
          0,
          node.x,
          node.y,
          node.radius * 3,
        );
        glow.addColorStop(0, rgba(color, glowAlpha));
        glow.addColorStop(1, rgba(color, 0));
        ctx!.fillStyle = glow;
        ctx!.beginPath();
        ctx!.arc(node.x, node.y, node.radius * 3, 0, Math.PI * 2);
        ctx!.fill();

        // Core
        ctx!.fillStyle = rgba(color, dimmed ? 0.2 : 0.85);
        ctx!.beginPath();
        ctx!.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
        ctx!.fill();

        // Label
        const labelAlpha = dimmed ? 0.1 : isHovered ? 0.9 : 0.5;
        ctx!.fillStyle = rgba([160, 160, 170], labelAlpha);
        ctx!.font = isHovered ? 'bold 10px sans-serif' : '9px sans-serif';
        ctx!.textAlign = 'center';
        const label =
          node.label.length > 20 ? `${node.label.slice(0, 17)}...` : node.label;
        ctx!.fillText(label, node.x, node.y + node.radius + 12);
      }
    }

    function tick() {
      applyForces(nodes, edges, nodeMap, w, h);
      updatePulses(pulses, edges, pulseTimer);
    }

    if (prefersReducedMotion) {
      for (let i = 0; i < 200; i++) tick();
      draw();
      return () => {
        canvas.removeEventListener('mousemove', handleMouseMove);
        canvas.removeEventListener('mouseleave', handleMouseLeave);
        canvas.removeEventListener('click', handleClick);
        ro.disconnect();
      };
    }

    function loop() {
      tick();
      draw();
      animRef.current = requestAnimationFrame(loop);
    }
    animRef.current = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(animRef.current);
      canvas.removeEventListener('mousemove', handleMouseMove);
      canvas.removeEventListener('mouseleave', handleMouseLeave);
      canvas.removeEventListener('click', handleClick);
      ro.disconnect();
    };
  }, [graphData, router]);

  return (
    <canvas
      ref={canvasRef}
      className="w-full h-full"
      tabIndex={-1}
      aria-label={ariaLabel}
    >
      {ariaLabel}
    </canvas>
  );
}
