use std::collections::HashSet;
use crate::*;
use crate::social_graph::{format_edge, load_unfollow_history_by, load_unfollow_history_for};

/// Find the starting offset for cursor-based pagination over a handle list.
pub(crate) fn cursor_offset(handles: &[String], cursor: &Option<String>) -> usize {
    cursor.as_ref()
        .and_then(|c| handles.iter().position(|h| h == c).map(|i| i + 1))
        .unwrap_or(0)
}

/// Cursor offset for edges — matches handle in combined (handle, is_incoming) list.
fn cursor_offset_edges(handles: &[(String, bool)], cursor: &Option<String>) -> usize {
    cursor.as_ref()
        .and_then(|c| handles.iter().position(|(h, _)| h == c).map(|i| i + 1))
        .unwrap_or(0)
}

/// Paginate a handle list, loading each agent and formatting its edge.
fn paginate_graph(
    handle: &str,
    handles: &[String],
    cursor: &Option<String>,
    limit: usize,
    edge_key_fn: impl Fn(&str, &str) -> String,
    direction: &str,
) -> Response {
    let start = cursor_offset(handles, cursor);
    let mut results = Vec::with_capacity(limit);
    let mut has_more = false;
    for h in handles.iter().skip(start) {
        if results.len() >= limit { has_more = true; break; }
        if let Some(agent) = load_agent(h) {
            results.push(format_edge(&agent, &edge_key_fn(h, handle), direction));
        }
    }
    let next = if has_more { results.last().and_then(|a| a["handle"].as_str()).map(String::from) } else { None };
    ok_paginated(serde_json::json!(results), limit as u32, next)
}

pub fn handle_get_followers(req: &Request) -> Response {
    let th = require_field!(req.handle.as_deref(), "Handle is required").to_lowercase();
    let _ = require_agent!(&th);
    let limit = req.limit.unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT) as usize;
    let handles = index_list(&keys::pub_followers(&th));
    paginate_graph(&th, &handles, &req.cursor, limit, |fh, handle| keys::pub_edge(fh, handle), "incoming")
}

pub fn handle_get_following(req: &Request) -> Response {
    let sh = require_field!(req.handle.as_deref(), "Handle is required").to_lowercase();
    let _ = require_agent!(&sh);
    let limit = req.limit.unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT) as usize;
    let handles = index_list(&keys::pub_following(&sh));
    paginate_graph(&sh, &handles, &req.cursor, limit, |th, handle| keys::pub_edge(handle, th), "outgoing")
}

/// Full neighborhood query: incoming, outgoing, or both — with optional unfollow history.
pub fn handle_get_edges(req: &Request) -> Response {
    let handle = require_field!(req.handle.as_deref(), "Handle is required").to_lowercase();
    let agent = require_agent!(&handle);
    let direction = req.direction.as_deref().unwrap_or("both");
    if !["incoming", "outgoing", "both"].contains(&direction) {
        return err_response("Invalid direction: use incoming, outgoing, or both");
    }
    let include_history = req.include_history.unwrap_or(false);
    let limit = req.limit.unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT) as usize;

    // Build a combined handle list with direction tags for pagination.
    // Each entry is (handle, is_incoming) so the cursor can resume correctly.
    // When direction=both, deduplicate mutual follows to prevent cursor skipping.
    let mut all_handles: Vec<(String, bool)> = Vec::new();
    let mut seen = HashSet::new();
    if direction == "incoming" || direction == "both" {
        for fh in index_list(&keys::pub_followers(&handle)) {
            seen.insert(fh.clone());
            all_handles.push((fh, true));
        }
    }
    if direction == "outgoing" || direction == "both" {
        for th in index_list(&keys::pub_following(&handle)) {
            if direction == "both" && seen.contains(&th) { continue; }
            all_handles.push((th, false));
        }
    }

    let total_edges = all_handles.len();
    let start = cursor_offset_edges(&all_handles, &req.cursor);

    let mut edges = Vec::with_capacity(limit);
    let mut has_more = false;
    for (h, incoming) in all_handles.iter().skip(start) {
        if edges.len() >= limit { has_more = true; break; }
        if let Some(a) = load_agent(h) {
            let (edge_key, dir) = if *incoming {
                (keys::pub_edge(h, &handle), "incoming")
            } else {
                (keys::pub_edge(&handle, h), "outgoing")
            };
            edges.push(format_edge(&a, &edge_key, dir));
        }
    }

    let next = if has_more { edges.last().and_then(|a| a["handle"].as_str()).map(String::from) } else { None };

    let mut history: Vec<serde_json::Value> = Vec::new();
    if include_history {
        if direction == "incoming" || direction == "both" {
            history.extend(load_unfollow_history_for(&handle));
        }
        if direction == "outgoing" || direction == "both" {
            history.extend(load_unfollow_history_by(&agent.near_account_id));
        }
    }

    ok_response(serde_json::json!({
        "handle": handle,
        "edges": edges,
        "edge_count": total_edges,
        "history": if include_history { serde_json::json!(history) } else { serde_json::json!(null) },
        "pagination": { "limit": limit, "next_cursor": next },
    }))
}
