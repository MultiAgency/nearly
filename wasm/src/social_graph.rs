use crate::{
    agent_handle_for_account, edge_timestamp, format_agent, load_agent,
    get_json, get_string, set_json, index_list, AgentRecord,
};

pub fn parse_edge(raw: &str) -> serde_json::Value {
    if let Ok(parsed) = serde_json::from_str(raw) {
        return parsed;
    }
    if let Ok(ts) = raw.parse::<u64>() {
        return serde_json::json!({ "ts": ts });
    }
    serde_json::json!({ "ts": null })
}

pub fn format_edge(agent: &AgentRecord, edge_key: &str, direction: &str) -> serde_json::Value {
    let mut entry = format_agent(agent);
    entry["direction"] = serde_json::json!(direction);
    if let Some(raw) = get_string(edge_key) {
        let edge = parse_edge(&raw);
        entry["follow_reason"] = edge
            .get("reason")
            .cloned()
            .unwrap_or(serde_json::json!(null));
        entry["followed_at"] = edge.get("ts").cloned().unwrap_or(serde_json::json!(null));
    }
    entry
}

pub fn append_to_index(idx_key: &str, key: &str) -> Result<(), String> {
    let mut idx: Vec<String> = get_json(idx_key).unwrap_or_default();
    if !idx.iter().any(|e| e == key) {
        idx.push(key.to_string());
        set_json(idx_key, &idx)
            .map_err(|e| format!("failed to update index {idx_key}: {e}"))?;
    }
    Ok(())
}

pub fn append_unfollow_index(handle: &str, key: &str) -> Result<(), String> {
    append_to_index(&crate::keys::unfollow_idx(handle), key)
}

pub fn append_unfollow_index_by_account(account: &str, key: &str) -> Result<(), String> {
    append_to_index(&crate::keys::unfollow_idx_by(account), key)
}

pub fn load_unfollow_history(
    idx_key: &str,
    resolve_handle: impl Fn(&[&str]) -> (String, &'static str),
) -> Vec<serde_json::Value> {
    let keys: Vec<String> = get_json(idx_key).unwrap_or_default();
    keys.iter()
        .filter_map(|key| {
            let raw = get_string(key)?;
            let mut entry = parse_edge(&raw);
            let parts: Vec<&str> = key.splitn(4, ':').collect();
            if parts.len() >= 3 {
                let (handle_val, direction) = resolve_handle(&parts);
                entry["handle"] = serde_json::json!(handle_val);
                entry["direction"] = serde_json::json!(direction);
            } else {
                return None;
            }
            Some(entry)
        })
        .collect()
}

pub fn load_unfollow_history_for(handle: &str) -> Vec<serde_json::Value> {
    load_unfollow_history(&crate::keys::unfollow_idx(handle), |parts| {
        let account = parts[1];
        let from =
            agent_handle_for_account(account).unwrap_or_else(|| account.to_string());
        (from, "was_unfollowed_by")
    })
}

pub fn load_unfollow_history_by(account: &str) -> Vec<serde_json::Value> {
    load_unfollow_history(&crate::keys::unfollow_idx_by(account), |parts| {
        (parts[2].to_string(), "unfollowed")
    })
}

/// Walk an edge list in reverse, counting entries newer than `since`.
/// `edge_key_fn` maps each handle in the list to its edge storage key.
fn count_edges_since(
    handles: &[String],
    since: u64,
    edge_key_fn: impl Fn(&str) -> String,
) -> usize {
    let mut count = 0;
    for h in handles.iter().rev() {
        let val = match get_string(&edge_key_fn(h)) { Some(v) => v, None => continue };
        let ts = match edge_timestamp(&val) { Some(t) => t, None => continue };
        if ts <= since { break; }
        count += 1;
    }
    count
}

/// Walk an edge list in reverse, collecting agent summaries newer than `since`.
/// `edge_key_fn` maps each handle in the list to its edge storage key.
fn collect_edges_since(
    handles: &[String],
    since: u64,
    edge_key_fn: impl Fn(&str) -> String,
) -> Vec<serde_json::Value> {
    let mut results = Vec::new();
    for h in handles.iter().rev() {
        let val = match get_string(&edge_key_fn(h)) { Some(v) => v, None => continue };
        let ts = match edge_timestamp(&val) { Some(t) => t, None => continue };
        if ts <= since { break; }
        if let Some(a) = load_agent(h) {
            results.push(serde_json::json!({ "handle": a.handle, "display_name": a.display_name, "description": a.description }));
        }
    }
    results
}

/// Collect new followers since `since` for a given handle, returned as JSON summaries.
pub fn new_followers_since(handle: &str, since: u64) -> Vec<serde_json::Value> {
    let followers = index_list(&crate::keys::pub_followers(handle));
    collect_edges_since(&followers, since, |fh| crate::keys::pub_edge(fh, handle))
}

/// Count new following edges since `since` for the given handle.
pub fn new_following_count_since(handle: &str, since: u64) -> usize {
    let following = index_list(&crate::keys::pub_following(handle));
    count_edges_since(&following, since, |th| crate::keys::pub_edge(handle, th))
}

/// Collect new following since `since` for the given handle, returned as JSON summaries.
pub fn new_following_since(handle: &str, since: u64) -> Vec<serde_json::Value> {
    let following = index_list(&crate::keys::pub_following(handle));
    collect_edges_since(&following, since, |th| crate::keys::pub_edge(handle, th))
}
