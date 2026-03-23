use std::collections::HashMap;
use crate::keys;
use crate::types::*;
use crate::store::*;
use crate::agent::*;

// ─── Agent Registry ────────────────────────────────────────────────────────

pub(crate) fn load_registry() -> Vec<String> {
    index_list(keys::pub_agents())
}

pub(crate) fn load_all_agents() -> Vec<AgentRecord> {
    load_registry().iter().filter_map(|h| load_agent(h)).collect()
}

pub(crate) fn registry_count() -> u64 {
    // Prefer the maintained meta counter (O(1)) over loading the full index (O(n)).
    get_string(keys::pub_meta_count())
        .and_then(|s| s.parse().ok())
        .unwrap_or_else(|| index_list(keys::pub_agents()).len() as u64)
}

pub(crate) fn add_to_registry(handle: &str) -> Result<(), String> {
    index_append(keys::pub_agents(), handle)?;
    let count = index_list(keys::pub_agents()).len();
    let count_bytes = count.to_string();
    set_public(keys::pub_meta_count(), count_bytes.as_bytes())?;
    let ts_bytes = now_secs().to_string();
    set_public(keys::pub_meta_updated(), ts_bytes.as_bytes())
}

// ─── Sorted indices ───────────────────────────────────────────────────────
// Stored as sorted Vec<String> entries ("{score:016}:{handle}") in public
// worker storage. Lexicographic order = descending score/time due to inversion.
//
// inv_score uses (i64::MAX / 2) offset, keeping values positive for trust
// scores up to ~4.6×10¹⁸ (unreachable via follower counts).

/// Generate the three sorted index entries for an agent.
fn sorted_entries(agent: &AgentRecord) -> [(String, String); 3] {
    let inv_score = (i64::MAX / 2).saturating_sub(trust_score(agent));
    let inv_created = u64::MAX - agent.created_at;
    let inv_active = u64::MAX - agent.last_active;
    [
        (keys::pub_sorted("trust"), format!("{inv_score:016}:{}", agent.handle)),
        (keys::pub_sorted("created"), format!("{inv_created:020}:{}", agent.handle)),
        (keys::pub_sorted("active"), format!("{inv_active:020}:{}", agent.handle)),
    ]
}

/// Write sorted index entries for an agent. Called on registration and when scores change.
pub(crate) fn write_sorted_indices(agent: &AgentRecord) -> Result<(), String> {
    for (key, entry) in &sorted_entries(agent) {
        index_insert_sorted(key, entry)?;
    }
    Ok(())
}

/// Remove old sorted index entries before writing new ones (scores/timestamps changed).
pub(crate) fn remove_sorted_indices(agent: &AgentRecord) {
    for (key, entry) in &sorted_entries(agent) {
        let _ = index_remove_sorted(key, entry);
    }
}

/// Load agents using sorted index. Returns (agents, next_cursor).
pub(crate) fn load_agents_sorted(
    sort: &str,
    limit: usize,
    cursor: &Option<String>,
    filter: impl Fn(&AgentRecord) -> bool,
) -> Result<(Vec<AgentRecord>, Option<String>), String> {
    let sort_key = match sort {
        "followers" => "trust",
        "newest" => "created",
        "active" => "active",
        _ => return Err("Invalid sort: use followers, newest, or active".to_string()),
    };

    let entries = index_list(&keys::pub_sorted(sort_key));

    // If sorted index is empty, fall back to unsorted load
    if entries.is_empty() {
        let mut agents = load_all_agents();
        match sort {
            "followers" => agents.sort_by_key(|b| std::cmp::Reverse(trust_score(b))),
            "newest" => agents.sort_by(|a, b| b.created_at.cmp(&a.created_at)),
            "active" => agents.sort_by(|a, b| b.last_active.cmp(&a.last_active)),
            _ => {}
        }
        let filtered: Vec<AgentRecord> = agents.into_iter().filter(|a| filter(a)).collect();
        let take = limit + 1;
        let start = cursor.as_ref().and_then(|c| filtered.iter().position(|a| a.handle == *c).map(|i| i + 1)).unwrap_or(0);
        let page: Vec<AgentRecord> = filtered.into_iter().skip(start).take(take).collect();
        let next = if page.len() > limit { Some(page[limit].handle.clone()) } else { None };
        let result: Vec<AgentRecord> = page.into_iter().take(limit).collect();
        return Ok((result, next));
    }

    // Entries are sorted lexicographically (descending by score/time due to inversion).
    // Each entry is "{score}:{handle}" — split on last ':' to extract handle.
    let mut past_cursor = cursor.is_none();
    let mut agents = Vec::with_capacity(limit + 1);

    for entry in &entries {
        let handle = match entry.rsplit(':').next() {
            Some(h) => h,
            None => continue,
        };

        if !past_cursor {
            if cursor.as_deref() == Some(handle) {
                past_cursor = true;
            }
            continue;
        }

        if let Some(agent) = load_agent(handle) {
            if filter(&agent) {
                agents.push(agent);
                if agents.len() > limit {
                    break;
                }
            }
        }
    }

    let next = if agents.len() > limit {
        Some(agents[limit].handle.clone())
    } else {
        None
    };
    agents.truncate(limit);
    Ok((agents, next))
}

/// Aggregate all tags across registered agents with their counts, sorted by count descending.
pub(crate) fn list_tags() -> Vec<(String, u32)> {
    let mut counts = HashMap::new();
    for agent in load_all_agents() {
        for tag in &agent.tags {
            *counts.entry(tag.clone()).or_insert(0u32) += 1;
        }
    }
    let mut tags: Vec<(String, u32)> = counts.into_iter().collect();
    tags.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    tags
}
