use crate::keys;
use crate::types::*;
use crate::store::*;

// ─── Agent CRUD ───────────────────────────────────────────────────────────

pub(crate) fn agent_handle_for_account(account_id: &str) -> Option<String> {
    get_string(&keys::near_account(account_id))
}

pub(crate) fn load_agent(handle: &str) -> Option<AgentRecord> {
    get_json::<AgentRecord>(&keys::pub_agent(handle))
}

pub(crate) fn save_agent(agent: &AgentRecord, before: &AgentRecord) -> Result<(), String> {
    use crate::registry::{write_sorted_indices, remove_sorted_indices};

    if trust_score(before) != trust_score(agent) || before.last_active != agent.last_active {
        remove_sorted_indices(before);
    }
    let bytes = serde_json::to_vec(agent).map_err(|e| e.to_string())?;
    set_public(&keys::pub_agent(&agent.handle), &bytes)?;
    write_sorted_indices(agent)
}

// ─── Scoring & formatting ─────────────────────────────────────────────────

pub(crate) fn trust_score(agent: &AgentRecord) -> i64 {
    agent.follower_count - agent.unfollow_count
}

pub(crate) fn format_agent(agent: &AgentRecord) -> serde_json::Value {
    serde_json::json!({
        "handle": agent.handle,
        "display_name": agent.display_name,
        "description": agent.description,
        "avatar_url": agent.avatar_url,
        "tags": agent.tags,
        "capabilities": agent.capabilities,
        "near_account_id": agent.near_account_id,
        "follower_count": agent.follower_count,
        "unfollow_count": agent.unfollow_count,
        "trust_score": trust_score(agent),
        "following_count": agent.following_count,
        "created_at": agent.created_at,
        "last_active": agent.last_active,
    })
}

// Profile completeness weights (out of 100).
// Core identity fields are worth 20 each; optional polish fields are worth 10.
const WEIGHT_HANDLE: u32 = 20;
const WEIGHT_NEAR_ACCOUNT: u32 = 20;
const WEIGHT_DESCRIPTION: u32 = 20;      // must be >10 chars to count
const WEIGHT_DISPLAY_NAME: u32 = 10;     // must differ from handle
const WEIGHT_TAGS: u32 = 20;
const WEIGHT_AVATAR: u32 = 10;

pub(crate) fn profile_completeness(agent: &AgentRecord) -> u32 {
    let mut score: u32 = 0;
    if !agent.handle.is_empty() { score += WEIGHT_HANDLE; }
    if !agent.near_account_id.is_empty() { score += WEIGHT_NEAR_ACCOUNT; }
    if agent.description.len() > 10 { score += WEIGHT_DESCRIPTION; }
    if agent.display_name != agent.handle { score += WEIGHT_DISPLAY_NAME; }
    if !agent.tags.is_empty() { score += WEIGHT_TAGS; }
    if agent.avatar_url.is_some() { score += WEIGHT_AVATAR; }
    score
}

/// Retry-once helper for agent count updates after follow/unfollow.
/// Applies `mutate` to the agent, saves, and retries once on conflict.
pub(crate) fn retry_agent_update(handle: &str, mutate: impl Fn(&mut AgentRecord)) {
    if let Some(before) = load_agent(handle) {
        let mut agent = before.clone();
        mutate(&mut agent);
        if save_agent(&agent, &before).is_err() {
            if let Some(before2) = load_agent(handle) {
                let mut agent2 = before2.clone();
                mutate(&mut agent2);
                let _ = save_agent(&agent2, &before2);
            }
        }
    }
}
