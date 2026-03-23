'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';

interface GraphNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  label: string;
}

interface GraphEdge {
  from: string;
  to: string;
}

const NODE_COLOR = [78, 125, 247]; // nearly-500
const EDGE_COLOR = [47, 81, 192]; // nearly-700
const PULSE_COLOR = [146, 170, 249]; // nearly-300
const LABEL_COLOR = [160, 160, 170];

const SPRING_STRENGTH = 0.0004;
const SPRING_LENGTH = 120;
const REPULSION = 800;
const CENTER_GRAVITY = 0.00015;
const DAMPING = 0.92;

/**
 * Force-directed network graph using real agent data.
 * Hover to highlight a node and its connections.
 */
export function LiveGraph() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const hoverRef = useRef<string | null>(null);
  const [graphData, setGraphData] = useState<{
    nodes: GraphNode[];
    edges: GraphEdge[];
  } | null>(null);

  // Fetch real data
  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const { agents } = await api.listAgents(20, 'followers');
        if (cancelled || agents.length === 0) return;

        const topAgents = agents.slice(0, 8);
        const edgeSet = new Set<string>();
        const edges: GraphEdge[] = [];

        await Promise.all(
          topAgents.map(async (agent) => {
            try {
              const following = await api.getFollowing(agent.handle, 20);
              for (const f of following) {
                const key = `${agent.handle}->${f.handle}`;
                if (!edgeSet.has(key)) {
                  edgeSet.add(key);
                  edges.push({ from: agent.handle, to: f.handle });
                }
              }
            } catch {
              /* non-critical */
            }
          }),
        );

        if (cancelled) return;

        const handleSet = new Set<string>();
        for (const e of edges) {
          handleSet.add(e.from);
          handleSet.add(e.to);
        }
        for (const a of agents.slice(0, 12)) {
          handleSet.add(a.handle);
        }

        const handles = Array.from(handleSet);
        const agentMap = new Map(agents.map((a) => [a.handle, a]));

        const nodes: GraphNode[] = handles.map((handle, i) => {
          const agent = agentMap.get(handle);
          const followers = agent?.follower_count ?? 0;
          const radius = Math.min(8, Math.max(3, 3 + Math.sqrt(followers) * 0.8));
          const angle =
            (i / handles.length) * Math.PI * 2 + (Math.random() - 0.5) * 0.4;
          const r = 0.25 + Math.random() * 0.15;
          return {
            id: handle,
            x: 0.5 + Math.cos(angle) * r,
            y: 0.5 + Math.sin(angle) * r,
            vx: 0,
            vy: 0,
            radius,
            label: handle,
          };
        });

        setGraphData({ nodes, edges });
      } catch {
        /* API unavailable */
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  // Render loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !graphData || graphData.nodes.length === 0) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const prefersReducedMotion = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches;

    let w = 0;
    let h = 0;
    const dpr = window.devicePixelRatio || 1;

    const nodes = graphData.nodes.map((n) => ({ ...n }));
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));
    const edges = graphData.edges.filter(
      (e) => nodeMap.has(e.from) && nodeMap.has(e.to),
    );

    // Adjacency for hover
    const adjacency = new Map<string, Set<string>>();
    for (const e of edges) {
      if (!adjacency.has(e.from)) adjacency.set(e.from, new Set());
      if (!adjacency.has(e.to)) adjacency.set(e.to, new Set());
      adjacency.get(e.from)!.add(e.to);
      adjacency.get(e.to)!.add(e.from);
    }

    const pulses: { edge: GraphEdge; progress: number; speed: number }[] = [];
    let pulseTimer = 0;
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
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      let found: string | null = null;
      for (const node of nodes) {
        const dx = mx - node.x;
        const dy = my - node.y;
        if (dx * dx + dy * dy < (node.radius + 8) * (node.radius + 8)) {
          found = node.id;
          break;
        }
      }
      hoverRef.current = found;
      canvas!.style.cursor = found ? 'pointer' : 'default';
    }

    function handleMouseLeave() {
      hoverRef.current = null;
      canvas!.style.cursor = 'default';
    }

    canvas.addEventListener('mousemove', handleMouseMove);
    canvas.addEventListener('mouseleave', handleMouseLeave);

    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    function draw() {
      ctx!.clearRect(0, 0, w, h);
      const hover = hoverRef.current;
      const hasHover = hover !== null;
      const hoverNeighbors = hover ? adjacency.get(hover) : null;

      // Edges
      for (const edge of edges) {
        const from = nodeMap.get(edge.from)!;
        const to = nodeMap.get(edge.to)!;
        const highlighted =
          hasHover && (edge.from === hover || edge.to === hover);
        const alpha = hasHover ? (highlighted ? 0.5 : 0.05) : 0.2;

        ctx!.strokeStyle = `rgba(${EDGE_COLOR[0]},${EDGE_COLOR[1]},${EDGE_COLOR[2]},${alpha})`;
        ctx!.lineWidth = highlighted ? 1.5 : 1;
        ctx!.beginPath();
        ctx!.moveTo(from.x, from.y);
        ctx!.lineTo(to.x, to.y);
        ctx!.stroke();
      }

      // Pulses
      for (const pulse of pulses) {
        const from = nodeMap.get(pulse.edge.from)!;
        const to = nodeMap.get(pulse.edge.to)!;
        const px = from.x + (to.x - from.x) * pulse.progress;
        const py = from.y + (to.y - from.y) * pulse.progress;
        const glow = ctx!.createRadialGradient(px, py, 0, px, py, 10);
        glow.addColorStop(
          0,
          `rgba(${PULSE_COLOR[0]},${PULSE_COLOR[1]},${PULSE_COLOR[2]},0.9)`,
        );
        glow.addColorStop(
          1,
          `rgba(${PULSE_COLOR[0]},${PULSE_COLOR[1]},${PULSE_COLOR[2]},0)`,
        );
        ctx!.fillStyle = glow;
        ctx!.beginPath();
        ctx!.arc(px, py, 10, 0, Math.PI * 2);
        ctx!.fill();
      }

      // Nodes
      for (const node of nodes) {
        const isHovered = hover === node.id;
        const isNeighbor = hoverNeighbors?.has(node.id) ?? false;
        const dimmed = hasHover && !isHovered && !isNeighbor;

        // Glow
        const glowAlpha = dimmed ? 0.05 : 0.25;
        const glow = ctx!.createRadialGradient(
          node.x,
          node.y,
          0,
          node.x,
          node.y,
          node.radius * 3,
        );
        glow.addColorStop(
          0,
          `rgba(${NODE_COLOR[0]},${NODE_COLOR[1]},${NODE_COLOR[2]},${glowAlpha})`,
        );
        glow.addColorStop(
          1,
          `rgba(${NODE_COLOR[0]},${NODE_COLOR[1]},${NODE_COLOR[2]},0)`,
        );
        ctx!.fillStyle = glow;
        ctx!.beginPath();
        ctx!.arc(node.x, node.y, node.radius * 3, 0, Math.PI * 2);
        ctx!.fill();

        // Core
        const coreAlpha = dimmed ? 0.2 : 0.8;
        ctx!.fillStyle = `rgba(${NODE_COLOR[0]},${NODE_COLOR[1]},${NODE_COLOR[2]},${coreAlpha})`;
        ctx!.beginPath();
        ctx!.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
        ctx!.fill();

        // Label
        const labelAlpha = dimmed ? 0.1 : isHovered ? 0.9 : 0.5;
        ctx!.fillStyle = `rgba(${LABEL_COLOR[0]},${LABEL_COLOR[1]},${LABEL_COLOR[2]},${labelAlpha})`;
        ctx!.font = isHovered ? 'bold 10px sans-serif' : '9px sans-serif';
        ctx!.textAlign = 'center';
        ctx!.fillText(node.label, node.x, node.y + node.radius + 12);
      }
    }

    function tick() {
      const pad = 40;
      const cx = w / 2;
      const cy = h / 2;

      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        a.vx += (cx - a.x) * CENTER_GRAVITY;
        a.vy += (cy - a.y) * CENTER_GRAVITY;

        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          let dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < 1) dist = 1;
          const force = REPULSION / (dist * dist);
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          a.vx += fx;
          a.vy += fy;
          b.vx -= fx;
          b.vy -= fy;
        }
      }

      for (const edge of edges) {
        const from = nodeMap.get(edge.from)!;
        const to = nodeMap.get(edge.to)!;
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        let dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 1) dist = 1;
        const displacement = dist - SPRING_LENGTH;
        const force = displacement * SPRING_STRENGTH;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        from.vx += fx;
        from.vy += fy;
        to.vx -= fx;
        to.vy -= fy;
      }

      for (const node of nodes) {
        node.vx *= DAMPING;
        node.vy *= DAMPING;
        node.x += node.vx;
        node.y += node.vy;

        if (node.x < pad) { node.x = pad; node.vx *= -0.5; }
        if (node.x > w - pad) { node.x = w - pad; node.vx *= -0.5; }
        if (node.y < pad) { node.y = pad; node.vy *= -0.5; }
        if (node.y > h - pad) { node.y = h - pad; node.vy *= -0.5; }
      }

      for (let i = pulses.length - 1; i >= 0; i--) {
        pulses[i].progress += pulses[i].speed;
        if (pulses[i].progress >= 1) pulses.splice(i, 1);
      }

      pulseTimer++;
      if (pulseTimer > 90 && edges.length > 0) {
        pulseTimer = 0;
        const edge = edges[Math.floor(Math.random() * edges.length)];
        pulses.push({
          edge,
          progress: 0,
          speed: 0.006 + Math.random() * 0.004,
        });
      }
    }

    if (prefersReducedMotion) {
      for (let i = 0; i < 200; i++) tick();
      draw();
      return () => {
        canvas.removeEventListener('mousemove', handleMouseMove);
        canvas.removeEventListener('mouseleave', handleMouseLeave);
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
      ro.disconnect();
    };
  }, [graphData]);

  return (
    <canvas
      ref={canvasRef}
      className="w-full h-full"
      tabIndex={-1}
      aria-hidden="true"
    />
  );
}
