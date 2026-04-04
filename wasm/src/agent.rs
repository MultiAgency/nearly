//! Agent record CRUD: load, save, format, and account-to-handle resolution.

use crate::keys;
use crate::store::*;
use crate::types::*;

/// Resolve account → handle, returning `None` if the mapping is absent or stale.
///
/// A mapping can become stale when the multi-step register write
/// fails partway through.  Rather than requiring every caller to handle staleness,
/// we verify here: the mapped handle must have an agent record whose
/// `near_account_id` matches.  Stale mappings are invisible to the rest of the
/// codebase.
pub(crate) fn agent_handle_for_account(account_id: &str) -> Option<(String, AgentRecord)> {
    let bytes = user_get_bytes(&keys::near_account(account_id));
    if bytes.is_empty() {
        return None;
    }
    let handle = String::from_utf8(bytes).ok()?;
    let agent = load_agent(&handle)?;
    if agent.near_account_id == account_id {
        Some((handle, agent))
    } else {
        None
    }
}

pub(crate) fn load_agent(handle: &str) -> Option<AgentRecord> {
    user_get_json::<AgentRecord>(&keys::pub_agent(handle))
}

pub(crate) fn save_agent(agent: &AgentRecord) -> Result<(), AppError> {
    let bytes = serde_json::to_vec(agent).map_err(|e| AppError::Storage(e.to_string()))?;
    user_set(&keys::pub_agent(&agent.handle), &bytes)
}

pub(crate) fn format_agent(agent: &AgentRecord) -> serde_json::Value {
    let endorsements = agent.endorsements.positive_only();
    serde_json::json!({
        "handle": agent.handle,
        "description": agent.description,
        "avatar_url": agent.avatar_url,
        "tags": agent.tags,
        "capabilities": agent.capabilities,
        "endorsements": endorsements,
        "platforms": agent.platforms,
        "near_account_id": agent.near_account_id,
        "follower_count": agent.follower_count,
        "following_count": agent.following_count,
        "created_at": agent.created_at,
        "last_active": agent.last_active,
    })
}

const MIN_MEANINGFUL_DESCRIPTION: usize = 10;

fn has_meaningful_capabilities(caps: &serde_json::Value) -> bool {
    caps.as_object().is_some_and(|o| !o.is_empty())
}

const WEIGHT_DESCRIPTION: u32 = 30;
const WEIGHT_TAGS: u32 = 30;
const WEIGHT_CAPABILITIES: u32 = 40;
const _: () = assert!(
    WEIGHT_DESCRIPTION + WEIGHT_TAGS + WEIGHT_CAPABILITIES == 100,
    "profile completeness weights must sum to 100"
);

pub(crate) fn profile_completeness(agent: &AgentRecord) -> u32 {
    let mut score: u32 = 0;
    if agent.description.len() > MIN_MEANINGFUL_DESCRIPTION {
        score += WEIGHT_DESCRIPTION;
    }
    if !agent.tags.is_empty() {
        score += WEIGHT_TAGS;
    }
    if has_meaningful_capabilities(&agent.capabilities) {
        score += WEIGHT_CAPABILITIES;
    }
    score
}
