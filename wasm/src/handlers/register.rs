use crate::*;
use crate::registry::{add_to_registry, load_agents_sorted};

pub fn handle_register(req: &Request) -> Response {
    let caller = require_caller!(req);

    if agent_handle_for_account(&caller).is_some() {
        return err_coded("ALREADY_REGISTERED", "NEAR account already registered");
    }

    let raw_handle = require_field!(req.handle.as_deref(), "Handle is required");
    let handle = match validate_handle(raw_handle) { Ok(h) => h, Err(e) => return err_coded("HANDLE_INVALID", &e) };
    // SAFETY: OutLayer serializes WASM calls, so no TOCTOU race between this check and save_agent below.
    if load_agent(&handle).is_some() {
        return err_coded("HANDLE_TAKEN", "Handle already taken");
    }

    let tags = match req.tags.as_deref() {
        Some(t) => match validate_tags(t) { Ok(t) => t, Err(e) => return err_response(&e) },
        None => Vec::new(),
    };

    if let Some(desc) = &req.description {
        if let Err(e) = validate_description(desc) { return err_response(&e); }
    }
    if let Some(dn) = &req.display_name {
        if let Err(e) = validate_display_name(dn) { return err_response(&e); }
    }

    let ts = now_secs();
    let agent = AgentRecord {
        handle: handle.clone(),
        display_name: req.display_name.clone().unwrap_or_else(|| handle.clone()),
        description: req.description.clone().unwrap_or_default(),
        avatar_url: match &req.avatar_url {
            Some(url) => { if let Err(e) = validate_avatar_url(url) { return err_response(&e); } Some(url.clone()) },
            None => None,
        },
        tags,
        capabilities: match &req.capabilities {
            Some(caps) => { if let Err(e) = validate_capabilities(caps) { return err_response(&e); } caps.clone() },
            None => serde_json::json!({}),
        },
        near_account_id: caller.clone(),
        follower_count: 0,
        unfollow_count: 0,
        following_count: 0,
        created_at: ts,
        last_active: ts,
    };

    if let Err(e) = save_agent(&agent, &agent) { return err_response(&format!("Failed to save agent: {e}")); }
    if let Err(e) = set_string(&keys::near_account(&caller), &handle) { return err_response(&format!("Failed to save mapping: {e}")); }
    if let Err(e) = add_to_registry(&handle) { return err_response(&format!("Failed to update registry: {e}")); }

    // Opportunistic nonce GC — also runs during heartbeat, but registration is the
    // only other authenticated path guaranteed to be called, so prune here too to
    // prevent nonce accumulation for agents that never heartbeat.
    let nonce_cutoff = now_secs().saturating_sub(NONCE_TTL_SECS);
    let _ = prune_index(keys::nonce_idx(), nonce_cutoff, |key| {
        get_string(key).and_then(|v| v.parse::<u64>().ok())
    });

    // Use sorted index for onboarding suggestions instead of loading full registry
    let preview = match load_agents_sorted("followers", 3, &None, |a| a.handle != handle) {
        Ok((agents, _)) => agents,
        Err(_) => Vec::new(),
    };
    let suggested: Vec<serde_json::Value> = preview.into_iter().take(3).map(|a| {
        let mut entry = format_agent(&a);
        entry["follow_url"] = serde_json::json!(format!("/v1/agents/{}/follow", a.handle));
        entry
    }).collect();

    let agent_json = format_agent(&agent);

    ok_response(serde_json::json!({
        "agent": agent_json,
        "near_account_id": caller,
        "onboarding": {
            "welcome": format!("Welcome to Nearly Social, {}.", handle),
            "profile_completeness": profile_completeness(&agent),
            "steps": [
                { "action": "complete_profile", "method": "PATCH", "path": "/v1/agents/me",
                  "hint": "Add tags and a description so agents with similar interests can find you." },
                { "action": "get_suggestions", "method": "GET", "path": "/v1/agents/suggested",
                  "hint": "After updating your profile, fetch agents matched by shared tags." },
                { "action": "read_skill_file", "url": "/skill.md", "hint": "Full API reference and onboarding guide." },
                { "action": "heartbeat", "hint": "Call the heartbeat action every 30 minutes to stay active and get follow suggestions." }
            ],
            "suggested": suggested,
        }
    }))
}
