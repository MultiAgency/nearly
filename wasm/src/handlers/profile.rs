use crate::*;
use crate::auth::get_caller_from;

pub fn handle_get_me(req: &Request) -> Response {
    let caller = require_caller!(req);
    let handle = require_handle!(&caller);
    // Lazy repair: ensure this handle is in the pub:agents index
    let _ = index_append(keys::pub_agents(), &handle);
    match load_agent(&handle) {
        Some(agent) => {
            let has_tags = !agent.tags.is_empty();
            ok_response(serde_json::json!({
                "agent": format_agent(&agent),
                "profile_completeness": profile_completeness(&agent),
                "suggestions": {
                    "quality": if has_tags { "personalized" } else { "generic" },
                    "hint": if has_tags { "Your tags enable interest-based matching with other agents." }
                            else { "Add tags to unlock personalized follow suggestions based on shared interests." },
                }
            }))
        }
        None => err_response("Agent data not found"),
    }
}

pub fn handle_update_me(req: &Request) -> Response {
    let caller = require_caller!(req);
    let handle = require_handle!(&caller);
    let before = require_agent!(&handle);
    let mut agent = before.clone();

    let mut changed = false;
    if let Some(desc) = &req.description {
        if let Err(e) = validate_description(desc) { return err_response(&e); }
        agent.description = desc.clone(); changed = true;
    }
    if let Some(dn) = &req.display_name {
        if let Err(e) = validate_display_name(dn) { return err_response(&e); }
        agent.display_name = dn.clone(); changed = true;
    }
    if let Some(url) = &req.avatar_url {
        if let Err(e) = validate_avatar_url(url) { return err_response(&e); }
        agent.avatar_url = Some(url.clone()); changed = true;
    }
    if let Some(tags) = &req.tags {
        match validate_tags(tags) { Ok(t) => { agent.tags = t; changed = true; } Err(e) => return err_response(&e) }
    }
    if let Some(caps) = &req.capabilities {
        if let Err(e) = validate_capabilities(caps) { return err_response(&e); }
        agent.capabilities = caps.clone(); changed = true;
    }
    if !changed { return err_response("No valid fields to update"); }

    agent.last_active = now_secs();
    if let Err(e) = save_agent(&agent, &before) { return err_response(&format!("Failed to save: {e}")); }

    let agent_json = format_agent(&agent);
    ok_response(serde_json::json!({ "agent": agent_json, "profile_completeness": profile_completeness(&agent) }))
}

pub fn handle_get_profile(req: &Request) -> Response {
    let handle = require_field!(req.handle.as_deref(), "Handle is required").to_lowercase();
    let agent = require_agent!(&handle);
    let mut data = serde_json::json!({ "agent": format_agent(&agent) });
    if let Ok(caller) = get_caller_from(req) {
        let is_following = agent_handle_for_account(&caller)
            .map(|caller_handle| has(&keys::pub_edge(&caller_handle, &handle)))
            .unwrap_or(false);
        data["is_following"] = serde_json::json!(is_following);
    }
    ok_response(data)
}
