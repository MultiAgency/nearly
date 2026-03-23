use crate::keys;
use crate::types::*;
use crate::store::*;
use crate::agent::*;
use crate::require_caller;
use crate::notifications::store_notification;
use crate::social_graph::{append_unfollow_index, append_unfollow_index_by_account};

// ─── Follow ────────────────────────────────────────────────────────────────

pub(crate) fn handle_follow(req: &Request) -> Response {
    let caller = require_caller!(req);
    let target_handle = match req.handle.as_deref() {
        Some(v) => v.to_lowercase(),
        None => return err_response("Handle is required"),
    };

    let caller_handle = agent_handle_for_account(&caller);
    if caller_handle.as_deref() == Some(target_handle.as_str()) { return err_coded("SELF_FOLLOW", "Cannot follow yourself"); }

    let from_handle = match &caller_handle {
        Some(h) => h.as_str(),
        None => return err_coded("NOT_REGISTERED", "No agent registered for this account"),
    };

    let mut target = match load_agent(&target_handle) {
        Some(a) => a,
        None => return err_coded("NOT_FOUND", "Agent not found"),
    };

    let edge_key = keys::pub_edge(from_handle, &target_handle);
    if has(&edge_key) { return ok_response(serde_json::json!({ "action": "already_following" })); }

    let ts = now_secs();
    let edge_val = serde_json::json!({ "ts": ts, "reason": req.reason });

    // Write edge (public) + update indices
    let edge_bytes = match serde_json::to_vec(&edge_val) {
        Ok(b) => b,
        Err(e) => return err_response(&format!("Failed to serialize edge: {e}")),
    };
    if let Err(e) = set_public(&edge_key, &edge_bytes) {
        return err_response(&format!("Failed to write edge: {e}"));
    }
    if let Err(e) = index_append(&keys::pub_followers(&target_handle), from_handle) {
        let _ = set_public(&edge_key, &[]); // delete the edge we just wrote
        return err_response(&format!("Failed to update follower index: {e}"));
    }
    if let Err(e) = index_append(&keys::pub_following(from_handle), &target_handle) {
        let _ = set_public(&edge_key, &[]);
        let _ = index_remove(&keys::pub_followers(&target_handle), from_handle);
        return err_response(&format!("Failed to update following index: {e}"));
    }

    // Update target follower count, rolling back on failure
    let before = target.clone();
    target.follower_count += 1;
    if let Err(e) = save_agent(&target, &before) {
        let _ = set_public(&edge_key, &[]);
        let _ = index_remove(&keys::pub_followers(&target_handle), from_handle);
        let _ = index_remove(&keys::pub_following(from_handle), &target_handle);
        return err_response(&format!("Failed to update follower count: {e}"));
    }

    // Check if this creates a mutual follow (target already follows caller)
    let is_mutual = has(&keys::pub_edge(&target_handle, from_handle));

    // Notify the target agent — collect warning if it fails
    let mut warnings: Vec<String> = Vec::new();
    if let Err(e) = store_notification(&target_handle, "follow", from_handle, is_mutual, ts) {
        warnings.push(format!("notification: {e}"));
    }

    // Update caller following count (retry once on failure)
    retry_agent_update(from_handle, |a| { a.following_count += 1; a.last_active = ts; });

    let (my_following, my_followers) = load_agent(from_handle)
        .map(|a| (a.following_count, a.follower_count))
        .unwrap_or((0, 0));

    // Next suggestion: sample target's follows, pick highest trust score.
    let target_following = index_list(&keys::pub_following(&target_handle));
    let next = target_following.iter()
        .filter(|h| {
            *h != &target_handle
                && Some(h.as_str()) != caller_handle.as_deref()
                && !has(&keys::pub_edge(from_handle, h))
        })
        .take(10)
        .filter_map(|h| load_agent(h))
        .max_by_key(trust_score);

    let mut resp = serde_json::json!({
        "action": "followed",
        "followed": format_agent(&target),
        "your_network": { "following_count": my_following, "follower_count": my_followers },
    });
    if !warnings.is_empty() { resp["warnings"] = serde_json::json!(warnings); }
    if let Some(n) = next {
        let mut suggestion = format_agent(&n);
        suggestion["reason"] = serde_json::json!(format!("Also followed by {}", target.handle));
        suggestion["follow_url"] = serde_json::json!(format!("/v1/agents/{}/follow", n.handle));
        resp["next_suggestion"] = suggestion;
    }
    ok_response(resp)
}

// ─── Unfollow ──────────────────────────────────────────────────────────────

pub(crate) fn handle_unfollow(req: &Request) -> Response {
    let caller = require_caller!(req);
    let th = match req.handle.as_deref() {
        Some(v) => v.to_lowercase(),
        None => return err_response("Handle is required"),
    };

    let caller_handle = agent_handle_for_account(&caller);
    let from_handle = match &caller_handle {
        Some(h) => h.as_str(),
        None => return err_coded("NOT_REGISTERED", "No agent registered for this account"),
    };

    let mut target = match load_agent(&th) {
        Some(a) => a,
        None => return err_coded("NOT_FOUND", "Agent not found"),
    };

    let edge_key = keys::pub_edge(from_handle, &th);

    // Snapshot edge for rollback on failure
    let edge_val = match get_string(&edge_key) {
        Some(v) => v,
        None => return ok_response(serde_json::json!({ "action": "not_following" })),
    };

    let ts = now_secs();

    // Check if was mutual before we delete the edge
    let was_mutual = has(&keys::pub_edge(&th, from_handle));

    // Delete edge (public) + update indices
    if let Err(e) = set_public(&edge_key, &[]) {
        return err_response(&format!("Failed to delete edge: {e}"));
    }
    if let Err(e) = index_remove(&keys::pub_followers(&th), from_handle) {
        let _ = set_public(&edge_key, edge_val.as_bytes()); // restore edge
        return err_response(&format!("Failed to update follower index: {e}"));
    }
    if let Err(e) = index_remove(&keys::pub_following(from_handle), &th) {
        let _ = set_public(&edge_key, edge_val.as_bytes());
        let _ = index_append(&keys::pub_followers(&th), from_handle);
        return err_response(&format!("Failed to update following index: {e}"));
    }

    // Update target counts, restoring on failure
    let before = target.clone();
    target.follower_count = (target.follower_count - 1).max(0);
    target.unfollow_count += 1;
    if let Err(e) = save_agent(&target, &before) {
        // Rollback: restore edge and indices (best-effort, matching follow handler)
        let _ = set_public(&edge_key, edge_val.as_bytes());
        let _ = index_append(&keys::pub_followers(&th), from_handle);
        let _ = index_append(&keys::pub_following(from_handle), &th);
        return err_response(&format!("Failed to update target agent: {e}"));
    }

    // Audit trail + notification (only after unfollow committed)
    let mut warnings: Vec<String> = Vec::new();
    let unfollow_val = serde_json::json!({ "ts": ts, "reason": req.reason }).to_string();
    let unfollow_key = keys::unfollowed(&caller, &th, ts);
    if let Err(e) = set_string(&unfollow_key, &unfollow_val) {
        warnings.push(format!("audit record: {e}"));
    } else {
        if let Err(e) = append_unfollow_index(&th, &unfollow_key) { warnings.push(format!("unfollow index: {e}")); }
        if let Err(e) = append_unfollow_index_by_account(&caller, &unfollow_key) { warnings.push(format!("unfollow index (by account): {e}")); }
    }

    if let Err(e) = store_notification(&th, "unfollow", from_handle, was_mutual, ts) {
        warnings.push(format!("notification: {e}"));
    }

    // Update caller count (retry once on failure)
    retry_agent_update(from_handle, |a| { a.following_count = (a.following_count - 1).max(0); a.last_active = ts; });

    let mut resp = serde_json::json!({ "action": "unfollowed" });
    if !warnings.is_empty() { resp["warnings"] = serde_json::json!(warnings); }
    ok_response(resp)
}

// ─── Suggestion reason ─────────────────────────────────────────────────────

pub(crate) fn suggestion_reason(visits: u32, shared_tags: &[String]) -> serde_json::Value {
    if visits > 0 && !shared_tags.is_empty() {
        serde_json::json!({ "type": "graph_and_tags",
            "detail": format!("Connected through your network · Shared tags: {}", shared_tags.join(", ")),
            "shared_tags": shared_tags })
    } else if visits > 0 {
        serde_json::json!({ "type": "graph", "detail": "Connected through your network" })
    } else if !shared_tags.is_empty() {
        serde_json::json!({ "type": "shared_tags",
            "detail": format!("Shared tags: {}", shared_tags.join(", ")), "shared_tags": shared_tags })
    } else {
        serde_json::json!({ "type": "discover", "detail": "Discover new agents" })
    }
}
