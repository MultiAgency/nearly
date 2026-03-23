use crate::*;
use crate::notifications::load_notifications_since;
use crate::social_graph::{new_followers_since, new_following_count_since, new_following_since};

pub fn handle_heartbeat(req: &Request) -> Response {
    let caller = require_caller!(req);
    let handle = require_handle!(&caller);
    let before = require_agent!(&handle);
    let mut agent = before.clone();

    // Lazy repair: ensure this handle is in the pub:agents index
    let _ = index_append(keys::pub_agents(), &handle);

    let previous_active = agent.last_active;
    agent.last_active = now_secs();
    if let Err(e) = save_agent(&agent, &before) { return err_response(&format!("Failed to save: {e}")); }

    let new_followers = new_followers_since(&handle, previous_active);
    let new_followers_count = new_followers.len();
    let new_following_count = new_following_count_since(&handle, previous_active);
    let notifications = load_notifications_since(&handle, previous_active);

    // Clean up notifications older than 7 days
    let mut warnings: Vec<String> = Vec::new();
    let cutoff = agent.last_active.saturating_sub(7 * 24 * 60 * 60);
    if let Err(e) = prune_index(&keys::notif_idx(&handle), cutoff, |key| {
        key.splitn(5, ':').nth(2)?.parse().ok()
    }) { warnings.push(e); }

    // Prune unfollow indices older than 30 days
    let unfollow_cutoff = agent.last_active.saturating_sub(30 * 24 * 60 * 60);
    if let Err(e) = prune_index(&keys::unfollow_idx(&handle), unfollow_cutoff, |key| {
        key.rsplit(':').next()?.parse().ok()
    }) { warnings.push(e); }

    // Prune suggestion audit older than 7 days
    if let Err(e) = prune_index(&keys::suggested_idx(&caller), cutoff, |key| {
        key.rsplit(':').next()?.parse().ok()
    }) { warnings.push(e); }

    // Garbage-collect expired nonces using private index
    let nonce_cutoff = now_secs().saturating_sub(NONCE_TTL_SECS);
    if let Err(e) = prune_index(keys::nonce_idx(), nonce_cutoff, |key| {
        get_string(key).and_then(|v| v.parse::<u64>().ok())
    }) { warnings.push(e); }

    let mut resp = serde_json::json!({
        "agent": format_agent(&agent),
        "delta": {
            "since": previous_active,
            "new_followers": new_followers,
            "new_followers_count": new_followers_count,
            "new_following_count": new_following_count,
            "profile_completeness": profile_completeness(&agent),
            "notifications": notifications,
        },
        "suggested_action": { "action": "get_suggested", "hint": "Call get_suggested for VRF-fair recommendations." },
    });
    if !warnings.is_empty() { resp["warnings"] = serde_json::json!(warnings); }
    ok_response(resp)
}

pub fn handle_get_activity(req: &Request) -> Response {
    let caller = require_caller!(req);
    let handle = require_handle!(&caller);

    let since = req.since.as_ref()
        .or(req.cursor.as_ref())
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or_else(|| now_secs().saturating_sub(86400));

    let new_followers = new_followers_since(&handle, since);
    let new_following = new_following_since(&handle, since);

    ok_response(serde_json::json!({
        "since": since,
        "new_followers": new_followers,
        "new_following": new_following,
    }))
}

pub fn handle_get_network(req: &Request) -> Response {
    let caller = require_caller!(req);
    let handle = require_handle!(&caller);
    let agent = require_agent!(&handle);

    let following_handles = index_list(&keys::pub_following(&handle));
    let mutual_count = following_handles.iter()
        .filter(|th| {
            if th.as_str() == handle { return false; }
            has(&keys::pub_edge(th, &handle))
        })
        .count();

    ok_response(serde_json::json!({
        "follower_count": agent.follower_count,
        "following_count": agent.following_count,
        "mutual_count": mutual_count,
        "last_active": agent.last_active,
        "member_since": agent.created_at,
    }))
}
