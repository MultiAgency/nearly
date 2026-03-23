use outlayer::env;

mod agent;
mod auth;
mod follow;
mod handlers;
mod nep413;
mod notifications;
mod registry;
mod social_graph;
mod suggest;
mod types;
mod store;

// Re-export at crate level so existing modules (social_graph, notifications,
// suggest, nep413) can continue using `crate::` paths.
pub(crate) use agent::*;
pub(crate) use types::*;
pub(crate) use store::*;

use follow::{handle_follow, handle_unfollow};
use handlers::*;
use registry::{list_tags, registry_count};

// ─── Auth / extraction macros ─────────────────────────────────────────────

/// Extract the authenticated caller, returning an error Response on failure.
#[macro_export]
macro_rules! require_caller {
    ($req:expr) => {
        match crate::auth::get_caller_from($req) { Ok(c) => c, Err(e) => return e }
    };
}

/// Extract an agent handle for the caller's account, returning an error Response if unregistered.
#[macro_export]
macro_rules! require_handle {
    ($account:expr) => {
        match agent_handle_for_account($account) {
            Some(h) => h,
            None => return err_coded("NOT_REGISTERED", "No agent registered for this account"),
        }
    };
}

/// Load an agent record by handle, returning an error Response if not found.
#[macro_export]
macro_rules! require_agent {
    ($handle:expr) => {
        match load_agent($handle) {
            Some(a) => a,
            None => return err_coded("NOT_FOUND", "Agent not found"),
        }
    };
}

/// Require an optional field from the request, returning an error Response with message if None.
#[macro_export]
macro_rules! require_field {
    ($opt:expr, $msg:expr) => {
        match $opt {
            Some(v) => v,
            None => return err_response($msg),
        }
    };
}

// ─── Main ──────────────────────────────────────────────────────────────────

fn main() {
    let response = match env::input_json::<Request>() {
        Ok(Some(req)) => match req.action {
            Action::Register => handle_register(&req),
            Action::GetMe => handle_get_me(&req),
            Action::UpdateMe => handle_update_me(&req),
            Action::GetProfile => handle_get_profile(&req),
            Action::ListAgents => handle_list_agents(&req, |_| true, "followers", DEFAULT_LIMIT),
            Action::GetSuggested => handle_get_suggested(&req),
            Action::Follow => handle_follow(&req),
            Action::Unfollow => handle_unfollow(&req),
            Action::GetFollowers => handle_get_followers(&req),
            Action::GetFollowing => handle_get_following(&req),
            Action::GetEdges => handle_get_edges(&req),
            Action::Heartbeat => handle_heartbeat(&req),
            Action::GetActivity => handle_get_activity(&req),
            Action::GetNetwork => handle_get_network(&req),
            Action::GetNotifications => handle_get_notifications(&req),
            Action::ReadNotifications => handle_read_notifications(&req),
            Action::ListTags => {
                let tags: Vec<serde_json::Value> = list_tags().into_iter()
                    .map(|(tag, count)| serde_json::json!({ "tag": tag, "count": count }))
                    .collect();
                ok_response(serde_json::json!({ "tags": tags }))
            }
            Action::Health => ok_response(serde_json::json!({
                "status": "ok",
                "agent_count": registry_count(),
            })),
        },
        Ok(None) => err_response("No input provided"),
        Err(e) => err_response(&format!("Invalid input: {e}")),
    };
    let _ = env::output_json(&response);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    fn make_agent(handle: &str) -> AgentRecord {
        AgentRecord {
            handle: handle.to_string(),
            display_name: handle.to_string(),
            description: String::new(),
            avatar_url: None,
            tags: vec![],
            capabilities: serde_json::json!({}),
            near_account_id: format!("{handle}.near"),
            follower_count: 0,
            unfollow_count: 0,
            following_count: 0,
            created_at: 1000,
            last_active: 1000,
        }
    }

    // ── Handle validation ────────────────────────────────────────────────

    #[test]
    fn valid_handles() {
        assert!(validate_handle("alice").is_ok());
        assert!(validate_handle("agent_007").is_ok());
        assert!(validate_handle("ab").is_ok());
        assert!(validate_handle(&"a".repeat(32)).is_ok());
    }

    #[test]
    fn handle_rejects_too_short() {
        assert!(validate_handle("a").is_err());
        assert!(validate_handle("").is_err());
    }

    #[test]
    fn handle_rejects_too_long() {
        assert!(validate_handle(&"a".repeat(33)).is_err());
    }

    #[test]
    fn handle_rejects_special_chars() {
        assert!(validate_handle("my-agent").is_err());
        assert!(validate_handle("my agent").is_err());
        assert!(validate_handle("agent@bot").is_err());
    }

    #[test]
    fn handle_rejects_reserved() {
        assert!(validate_handle("admin").is_err());
        assert!(validate_handle("system").is_err());
        assert!(validate_handle("near").is_err());
    }

    #[test]
    fn handle_lowercases() {
        assert_eq!(validate_handle("Alice").unwrap(), "alice");
        assert_eq!(validate_handle("MyBot").unwrap(), "mybot");
    }

    // ── Tag validation ───────────────────────────────────────────────────

    #[test]
    fn valid_tags() {
        assert!(validate_tags(&["rust".into(), "ai".into()]).is_ok());
        assert!(validate_tags(&["web-3".into()]).is_ok());
    }

    #[test]
    fn tags_reject_over_limit() {
        let tags: Vec<String> = (0..11).map(|i| format!("tag{i}")).collect();
        assert!(validate_tags(&tags).is_err());
    }

    #[test]
    fn tags_reject_long_tag() {
        assert!(validate_tags(&["a".repeat(31)]).is_err());
    }

    #[test]
    fn tags_reject_invalid_chars() {
        assert!(validate_tags(&["has space".into()]).is_err());
        assert!(validate_tags(&["under_score".into()]).is_err());
    }

    #[test]
    fn tags_lowercase() {
        let result = validate_tags(&["RUST".into()]).unwrap();
        assert_eq!(result, vec!["rust"]);
    }

    // ── Trust score ──────────────────────────────────────────────────────

    #[test]
    fn trust_score_calculation() {
        let mut agent = make_agent("test");
        agent.follower_count = 10;
        agent.unfollow_count = 3;
        assert_eq!(trust_score(&agent), 7);
    }

    #[test]
    fn trust_score_negative() {
        let mut agent = make_agent("test");
        agent.follower_count = 2;
        agent.unfollow_count = 5;
        assert_eq!(trust_score(&agent), -3);
    }

    // ── Profile completeness ─────────────────────────────────────────────

    #[test]
    fn profile_completeness_empty() {
        let mut agent = make_agent("test");
        agent.near_account_id = String::new();
        assert_eq!(profile_completeness(&agent), 20);
    }

    #[test]
    fn profile_completeness_full() {
        let mut agent = make_agent("test");
        agent.display_name = "Test Agent".to_string();
        agent.description = "A test agent for validation".to_string();
        agent.tags = vec!["rust".into()];
        agent.avatar_url = Some("https://example.com/img.png".to_string());
        assert_eq!(profile_completeness(&agent), 100);
    }

    // ── Agent formatting ─────────────────────────────────────────────────

    #[test]
    fn format_agent_field_names_match_frontend_contract() {
        let mut agent = make_agent("alice");
        agent.display_name = "Alice".to_string();
        agent.description = "A test agent".to_string();
        agent.avatar_url = Some("https://example.com/alice.png".to_string());
        agent.tags = vec!["ai".to_string()];
        agent.capabilities = serde_json::json!({"skills": ["chat"]});
        agent.follower_count = 5;
        agent.unfollow_count = 1;
        agent.following_count = 3;

        let json = format_agent(&agent);
        let obj = json.as_object().expect("format_agent must return an object");

        let required_fields = [
            "handle", "display_name", "description", "avatar_url",
            "tags", "capabilities", "near_account_id",
            "follower_count", "unfollow_count", "trust_score",
            "following_count", "created_at", "last_active",
        ];
        for field in &required_fields {
            assert!(obj.contains_key(*field), "Missing field: {field}");
        }

        for key in obj.keys() {
            assert!(required_fields.contains(&key.as_str()), "Unexpected field: {key}");
        }

        assert!(json["handle"].is_string());
        assert!(json["follower_count"].is_number());
        assert!(json["trust_score"].is_number());
        assert!(json["created_at"].is_number());
        assert!(json["tags"].is_array());
    }

    // ── Edge timestamp parsing ───────────────────────────────────────────

    #[test]
    fn edge_timestamp_plain_number() {
        assert_eq!(edge_timestamp("1700000000"), Some(1700000000));
    }

    #[test]
    fn edge_timestamp_json() {
        assert_eq!(edge_timestamp(r#"{"ts":1700000000,"reason":"test"}"#), Some(1700000000));
    }

    #[test]
    fn edge_timestamp_invalid() {
        assert_eq!(edge_timestamp("not-a-number"), None);
    }

    // ── Suggestion engine ────────────────────────────────────────────────

    #[test]
    fn rng_deterministic() {
        let mut r1 = suggest::Rng::from_bytes(b"seed");
        let mut r2 = suggest::Rng::from_bytes(b"seed");
        assert_eq!(r1.next(), r2.next());
        assert_eq!(r1.next(), r2.next());
    }

    #[test]
    fn rng_shuffle_preserves_elements() {
        let mut rng = suggest::Rng::from_bytes(b"shuffle");
        let mut items = vec![1, 2, 3, 4, 5];
        rng.shuffle(&mut items);
        items.sort();
        assert_eq!(items, vec![1, 2, 3, 4, 5]);
    }

    #[test]
    fn random_walk_empty_follows() {
        let mut rng = suggest::Rng::from_bytes(b"empty");
        let visits = suggest::random_walk_visits(
            &mut rng, &[], &std::collections::HashSet::new(), None,
            &mut |_| vec![],
        );
        assert!(visits.is_empty());
    }

    #[test]
    fn rank_candidates_respects_limit() {
        let mut rng = suggest::Rng::from_bytes(b"rank");
        let candidates: Vec<AgentRecord> = (0..10).map(|i| {
            let mut a = make_agent(&format!("agent_{i}"));
            a.tags = vec!["ai".into()];
            a
        }).collect();
        let visits: std::collections::HashMap<String, u32> = candidates.iter()
            .map(|a| (a.handle.clone(), 5)).collect();
        let ranked = suggest::rank_candidates(&mut rng, candidates, &visits, &["ai".into()], 3);
        assert_eq!(ranked.len(), 3);
    }

    #[test]
    fn rank_candidates_scores_by_visits() {
        let mut rng = suggest::Rng::from_bytes(b"score");
        let mut a1 = make_agent("popular");
        a1.follower_count = 1;
        let mut a2 = make_agent("unknown");
        a2.follower_count = 1;
        let mut visits = std::collections::HashMap::new();
        visits.insert("popular".to_string(), 50u32);
        visits.insert("unknown".to_string(), 1u32);
        let ranked = suggest::rank_candidates(&mut rng, vec![a1, a2], &visits, &[], 10);
        assert_eq!(ranked[0].agent.handle, "popular");
    }

    #[test]
    fn different_seeds_produce_different_rankings() {
        let candidates: Vec<AgentRecord> = (0..5).map(|i| {
            let mut a = make_agent(&format!("ent_{i}"));
            a.tags = vec!["ai".into()];
            a.follower_count = 1;
            a
        }).collect();
        let visits: std::collections::HashMap<String, u32> = candidates.iter()
            .map(|a| (a.handle.clone(), 3)).collect();

        let mut rng_a = suggest::Rng::from_bytes(b"seed_alpha");
        let ranked_a = suggest::rank_candidates(&mut rng_a, candidates.clone(), &visits, &["ai".into()], 5);

        let mut rng_b = suggest::Rng::from_bytes(b"seed_bravo");
        let ranked_b = suggest::rank_candidates(&mut rng_b, candidates, &visits, &["ai".into()], 5);

        let order_a: Vec<&str> = ranked_a.iter().map(|s| s.agent.handle.as_str()).collect();
        let order_b: Vec<&str> = ranked_b.iter().map(|s| s.agent.handle.as_str()).collect();
        assert_ne!(order_a, order_b, "different seeds should produce different orderings");
    }

    // ── Reserved handles ─────────────────────────────────────────────────

    #[test]
    fn all_reserved_handles_rejected() {
        for &h in RESERVED_HANDLES {
            assert!(validate_handle(h).is_err(), "Expected {h} to be reserved");
        }
    }

    // ── Action dispatch coverage ─────────────────────────────────────────

    #[test]
    fn all_action_variants_deserialize_from_snake_case() {
        let actions = [
            "register", "get_me", "update_me", "get_profile",
            "list_agents", "get_suggested",
            "follow", "unfollow", "get_followers", "get_following",
            "get_edges", "heartbeat", "get_activity", "get_network",
            "get_notifications", "read_notifications", "list_tags", "health",
        ];
        for action_str in &actions {
            let json = format!(r#""{action_str}""#);
            let result: Result<Action, _> = serde_json::from_str(&json);
            assert!(result.is_ok(), "Failed to deserialize action: {action_str}");
        }
        assert_eq!(actions.len(), 18, "Action count mismatch — did you add a new action?");
    }

    // ── Tag deduplication behavior ───────────────────────────────────────

    #[test]
    fn duplicate_tags_are_deduplicated() {
        let result = validate_tags(&["rust".into(), "rust".into(), "ai".into()]).unwrap();
        assert_eq!(result, vec!["rust", "ai"]);
    }

    #[test]
    fn duplicate_tags_case_insensitive() {
        let result = validate_tags(&["Rust".into(), "rust".into()]).unwrap();
        assert_eq!(result, vec!["rust"]);
    }

    // ── Profile completeness boundary ────────────────────────────────────

    #[test]
    fn profile_completeness_description_boundary() {
        let mut agent = make_agent("test");
        agent.description = "exactly_10".to_string();
        assert_eq!(agent.description.len(), 10);
        assert_eq!(profile_completeness(&agent), 40);

        agent.description = "eleven_char".to_string();
        assert_eq!(agent.description.len(), 11);
        assert_eq!(profile_completeness(&agent), 60);
    }

    // ── Profile completeness variations ─────────────────────────────────

    #[test]
    fn profile_completeness_tags_add_score() {
        let mut agent = make_agent("test");
        let without_tags = profile_completeness(&agent);
        agent.tags = vec!["ai".into()];
        let with_tags = profile_completeness(&agent);
        assert!(with_tags > without_tags);
    }

    #[test]
    fn profile_completeness_avatar_adds_score() {
        let mut agent = make_agent("test");
        let without_avatar = profile_completeness(&agent);
        agent.avatar_url = Some("https://example.com/pic.png".into());
        let with_avatar = profile_completeness(&agent);
        assert!(with_avatar > without_avatar);
    }

    #[test]
    fn profile_completeness_custom_display_name_adds_score() {
        let mut agent = make_agent("test");
        // make_agent sets display_name == handle, so no bonus
        let baseline = profile_completeness(&agent);
        agent.display_name = "Custom Name".to_string();
        let with_name = profile_completeness(&agent);
        assert!(with_name > baseline);
    }

    // ── Cursor offset ─────────────────────────────────────────────────────

    #[test]
    fn cursor_offset_returns_zero_when_no_cursor() {
        let handles = vec!["alice".into(), "bob".into()];
        assert_eq!(cursor_offset(&handles, &None), 0);
    }

    #[test]
    fn cursor_offset_returns_position_after_match() {
        let handles = vec!["alice".into(), "bob".into(), "carol".into()];
        assert_eq!(cursor_offset(&handles, &Some("bob".into())), 2);
    }

    #[test]
    fn cursor_offset_returns_zero_when_cursor_not_found() {
        let handles = vec!["alice".into(), "bob".into()];
        assert_eq!(cursor_offset(&handles, &Some("unknown".into())), 0);
    }

    // ── NEP-413 nonce reuse ──────────────────────────────────────────────

    #[test]
    fn verify_auth_is_stateless_accepts_same_nonce_twice() {
        let (auth, now_ms) = nep413::tests::make_auth_for_test();
        assert!(nep413::verify_auth(&auth, now_ms).is_ok());
        assert!(nep413::verify_auth(&auth, now_ms).is_ok());
    }

    // ── Follow / Unfollow logic ─────────────────────────────────────────

    #[test]
    fn edge_timestamp_extracts_from_follow_value() {
        let with_reason = serde_json::json!({ "ts": 1700000000u64, "reason": "interesting" }).to_string();
        assert_eq!(edge_timestamp(&with_reason), Some(1700000000));

        let null_reason = serde_json::json!({ "ts": 1700000000u64, "reason": null }).to_string();
        assert_eq!(edge_timestamp(&null_reason), Some(1700000000));
    }

    #[test]
    fn trust_score_tracks_follow_unfollow_lifecycle() {
        let mut agent = make_agent("bob");
        assert_eq!(trust_score(&agent), 0);

        agent.follower_count = 5;
        assert_eq!(trust_score(&agent), 5);

        agent.follower_count = 3;
        agent.unfollow_count = 2;
        assert_eq!(trust_score(&agent), 1);

        agent.follower_count = 1;
        agent.unfollow_count = 4;
        assert_eq!(trust_score(&agent), -3);
    }

    // ── Nonce invariants ────────────────────────────────────────────────

    #[test]
    fn nonce_ttl_exceeds_timestamp_window() {
        assert!(NONCE_TTL_SECS > nep413::TIMESTAMP_WINDOW_MS / 1000,
            "NONCE_TTL_SECS ({NONCE_TTL_SECS}) must exceed timestamp window ({}s)",
            nep413::TIMESTAMP_WINDOW_MS / 1000);
    }

    // ── Description/display name validation ──────────────────────────────

    #[test]
    fn validate_description_rejects_over_limit() {
        assert!(validate_description(&"a".repeat(501)).is_err());
        assert!(validate_description(&"a".repeat(500)).is_ok());
    }

    #[test]
    fn validate_display_name_rejects_over_limit() {
        assert!(validate_display_name(&"a".repeat(65)).is_err());
        assert!(validate_display_name(&"a".repeat(64)).is_ok());
    }

    // ══════════════════════════════════════════════════════════════════════
    // Integration tests — exercise handler functions with in-memory storage
    // ══════════════════════════════════════════════════════════════════════

    /// Set up a fresh test environment: clear storage and set signer.
    fn setup_integration(account: &str) {
        store::test_backend::clear();
        unsafe { std::env::set_var("NEAR_SENDER_ID", account) };
    }

    /// Switch signer without clearing storage (for multi-agent tests).
    fn set_signer(account: &str) {
        unsafe { std::env::set_var("NEAR_SENDER_ID", account) };
    }

    /// Helper to build a Request for testing.
    fn test_request(action: Action) -> Request {
        Request {
            action,
            handle: None,
            description: None,
            display_name: None,
            avatar_url: None,
            tags: None,
            capabilities: None,
            verifiable_claim: None,
            limit: None,
            cursor: None,
            sort: None,
            direction: None,
            include_history: None,
            since: None,
            reason: None,
        }
    }

    fn parse_response(resp: &Response) -> serde_json::Value {
        let data = resp.data.as_ref().expect("response should have data");
        data.clone()
    }

    // ── Registration integration ──────────────────────────────────────────

    #[test]
    #[serial]
    fn integration_register_creates_agent_in_storage() {
        setup_integration("alice.near");
        let mut req = test_request(Action::Register);
        req.handle = Some("alice".into());
        req.description = Some("Test agent".into());
        req.tags = Some(vec!["ai".into(), "rust".into()]);

        let resp = handle_register(&req);
        assert!(resp.success, "register should succeed: {:?}", resp.error);

        let data = parse_response(&resp);
        assert_eq!(data["agent"]["handle"], "alice");
        assert_eq!(data["agent"]["description"], "Test agent");
        assert_eq!(data["near_account_id"], "alice.near");

        // Verify agent is loadable from storage
        let agent = load_agent("alice").expect("agent should be in storage");
        assert_eq!(agent.handle, "alice");
        assert_eq!(agent.near_account_id, "alice.near");
        assert_eq!(agent.tags, vec!["ai", "rust"]);
    }

    #[test]
    #[serial]
    fn integration_register_rejects_duplicate_account() {
        setup_integration("bob.near");
        let mut req = test_request(Action::Register);
        req.handle = Some("bob".into());

        let resp1 = handle_register(&req);
        assert!(resp1.success);

        // Same account, different handle
        req.handle = Some("bob2".into());
        let resp2 = handle_register(&req);
        assert!(!resp2.success);
        assert_eq!(resp2.code.as_deref(), Some("ALREADY_REGISTERED"));
    }

    #[test]
    #[serial]
    fn integration_register_rejects_duplicate_handle() {
        setup_integration("carol.near");
        let mut req = test_request(Action::Register);
        req.handle = Some("shared_handle".into());

        let resp1 = handle_register(&req);
        assert!(resp1.success);

        // Different account, same handle — don't clear storage
        set_signer("dave.near");
        let resp2 = handle_register(&req);
        assert!(!resp2.success);
        assert_eq!(resp2.code.as_deref(), Some("HANDLE_TAKEN"));
    }

    // ── Get profile integration ───────────────────────────────────────────

    #[test]
    #[serial]
    fn integration_get_me_returns_registered_agent() {
        setup_integration("eve.near");
        let mut reg = test_request(Action::Register);
        reg.handle = Some("eve".into());
        reg.description = Some("Eve's agent".into());
        handle_register(&reg);

        let req = test_request(Action::GetMe);
        let resp = handle_get_me(&req);
        assert!(resp.success);

        let data = parse_response(&resp);
        assert_eq!(data["agent"]["handle"], "eve");
        assert_eq!(data["agent"]["description"], "Eve's agent");
        assert!(data["profile_completeness"].is_number());
    }

    #[test]
    #[serial]
    fn integration_get_me_fails_for_unregistered() {
        setup_integration("nobody.near");
        let req = test_request(Action::GetMe);
        let resp = handle_get_me(&req);
        assert!(!resp.success);
        assert_eq!(resp.code.as_deref(), Some("NOT_REGISTERED"));
    }

    // ── Follow / unfollow integration ─────────────────────────────────────

    #[test]
    #[serial]
    fn integration_follow_and_unfollow_updates_counts() {
        // Register two agents
        setup_integration("follower.near");
        let mut reg = test_request(Action::Register);
        reg.handle = Some("follower_agent".into());
        handle_register(&reg);

        set_signer("target.near");
        reg.handle = Some("target_agent".into());
        handle_register(&reg);

        // Follow
        set_signer("follower.near");
        let mut follow_req = test_request(Action::Follow);
        follow_req.handle = Some("target_agent".into());
        let resp = handle_follow(&follow_req);
        assert!(resp.success, "follow should succeed: {:?}", resp.error);

        // Verify counts
        let target = load_agent("target_agent").unwrap();
        assert_eq!(target.follower_count, 1);
        let follower = load_agent("follower_agent").unwrap();
        assert_eq!(follower.following_count, 1);

        // Unfollow
        let mut unfollow_req = test_request(Action::Unfollow);
        unfollow_req.handle = Some("target_agent".into());
        let resp = handle_unfollow(&unfollow_req);
        assert!(resp.success, "unfollow should succeed: {:?}", resp.error);

        // Verify counts after unfollow
        let target = load_agent("target_agent").unwrap();
        assert_eq!(target.follower_count, 0);
        assert_eq!(target.unfollow_count, 1);
    }

    #[test]
    #[serial]
    fn integration_follow_self_is_rejected() {
        setup_integration("selfish.near");
        let mut reg = test_request(Action::Register);
        reg.handle = Some("selfish".into());
        handle_register(&reg);

        let mut follow_req = test_request(Action::Follow);
        follow_req.handle = Some("selfish".into());
        let resp = handle_follow(&follow_req);
        assert!(!resp.success);
    }

    // ── List agents integration ───────────────────────────────────────────

    #[test]
    #[serial]
    fn integration_list_agents_returns_registered() {
        setup_integration("agent_a.near");
        let mut reg = test_request(Action::Register);
        reg.handle = Some("agent_a".into());
        handle_register(&reg);

        set_signer("agent_b.near");
        reg.handle = Some("agent_b".into());
        handle_register(&reg);

        let req = test_request(Action::ListAgents);
        let resp = handle_list_agents(&req, |_| true, "followers", DEFAULT_LIMIT);
        assert!(resp.success);

        let data = parse_response(&resp);
        let agents = data.as_array().expect("data should be array");
        assert_eq!(agents.len(), 2);
    }

    // ── Update profile integration ────────────────────────────────────────

    #[test]
    #[serial]
    fn integration_update_me_changes_fields() {
        setup_integration("updater.near");
        let mut reg = test_request(Action::Register);
        reg.handle = Some("updater".into());
        handle_register(&reg);

        let mut update = test_request(Action::UpdateMe);
        update.description = Some("Updated description".into());
        update.display_name = Some("Updated Name".into());
        update.tags = Some(vec!["new-tag".into()]);
        let resp = handle_update_me(&update);
        assert!(resp.success, "update should succeed: {:?}", resp.error);

        let agent = load_agent("updater").unwrap();
        assert_eq!(agent.description, "Updated description");
        assert_eq!(agent.display_name, "Updated Name");
        assert_eq!(agent.tags, vec!["new-tag"]);
    }

    // ── Auth: nonce replay protection ─────────────────────────────────────

    #[test]
    #[serial]
    fn integration_nonce_replay_rejected() {
        store::test_backend::clear();
        unsafe { std::env::remove_var("NEAR_SENDER_ID") };

        let (auth, now_ms) = nep413::tests::make_auth_for_test();
        // Set block timestamp to match auth so it's not expired
        let block_ts_ns = (now_ms / 1000) * 1_000_000_000;
        unsafe { std::env::set_var("NEAR_BLOCK_TIMESTAMP", block_ts_ns.to_string()) };

        // First call — nonce is fresh, should succeed
        let result1 = auth::get_caller_from(&Request {
            action: Action::GetMe,
            verifiable_claim: Some(auth.clone()),
            ..test_request(Action::GetMe)
        });
        assert!(result1.is_ok(), "first auth should succeed: {:?}", result1.err().map(|r| r.error));

        // Second call with SAME nonce — must be rejected as replay
        let result2 = auth::get_caller_from(&Request {
            action: Action::GetMe,
            verifiable_claim: Some(auth),
            ..test_request(Action::GetMe)
        });
        assert!(result2.is_err(), "second auth with same nonce should fail");
        let err_resp = result2.unwrap_err();
        assert_eq!(err_resp.code.as_deref(), Some("NONCE_REPLAY"));

        // Clean up env for other tests
        unsafe { std::env::remove_var("NEAR_BLOCK_TIMESTAMP") };
    }

    // ── Storage consistency invariants ─────────────────────────────────────

    #[test]
    #[serial]
    fn integration_follow_unfollow_maintains_index_consistency() {
        setup_integration("idx_a.near");
        let mut reg = test_request(Action::Register);
        reg.handle = Some("idx_a".into());
        handle_register(&reg);

        set_signer("idx_b.near");
        reg.handle = Some("idx_b".into());
        handle_register(&reg);

        // Follow
        set_signer("idx_a.near");
        let mut follow_req = test_request(Action::Follow);
        follow_req.handle = Some("idx_b".into());
        handle_follow(&follow_req);

        // Invariant: follower count == followers index length
        let target = load_agent("idx_b").unwrap();
        let followers_idx = index_list(&keys::pub_followers("idx_b"));
        assert_eq!(target.follower_count as usize, followers_idx.len(),
            "follower_count ({}) must match followers index length ({})",
            target.follower_count, followers_idx.len());

        let follower = load_agent("idx_a").unwrap();
        let following_idx = index_list(&keys::pub_following("idx_a"));
        assert_eq!(follower.following_count as usize, following_idx.len(),
            "following_count ({}) must match following index length ({})",
            follower.following_count, following_idx.len());

        // Edge must exist
        assert!(has(&keys::pub_edge("idx_a", "idx_b")));

        // Unfollow
        let mut unfollow_req = test_request(Action::Unfollow);
        unfollow_req.handle = Some("idx_b".into());
        handle_unfollow(&unfollow_req);

        // Invariant after unfollow
        let target = load_agent("idx_b").unwrap();
        let followers_idx = index_list(&keys::pub_followers("idx_b"));
        assert_eq!(target.follower_count as usize, followers_idx.len());
        assert!(!has(&keys::pub_edge("idx_a", "idx_b")), "edge should be deleted");
    }

    #[test]
    #[serial]
    fn integration_follow_with_injected_failure_rolls_back() {
        setup_integration("fail_a.near");
        let mut reg = test_request(Action::Register);
        reg.handle = Some("fail_a".into());
        handle_register(&reg);

        set_signer("fail_b.near");
        reg.handle = Some("fail_b".into());
        handle_register(&reg);

        // Snapshot state before attempted follow
        let before_target = load_agent("fail_b").unwrap();
        let _before_followers = index_list(&keys::pub_followers("fail_b"));

        // Inject write failures — enough to break save_agent inside follow
        // (after edge+index writes succeed, save_agent will fail)
        set_signer("fail_a.near");
        store::test_backend::fail_next_writes(10);

        let mut follow_req = test_request(Action::Follow);
        follow_req.handle = Some("fail_b".into());
        let resp = handle_follow(&follow_req);

        // Follow should have failed
        assert!(!resp.success, "follow should fail when storage fails");

        // Clear failure flag for subsequent reads
        store::test_backend::fail_next_writes(0);

        // The follower count should be unchanged (rollback or never incremented)
        let after_target = load_agent("fail_b");
        if let Some(agent) = after_target {
            assert_eq!(agent.follower_count, before_target.follower_count,
                "follower count should not increase on failed follow");
        }
    }

    #[test]
    #[serial]
    fn integration_unfollow_with_injected_failure_rolls_back() {
        setup_integration("uf_a.near");
        let mut reg = test_request(Action::Register);
        reg.handle = Some("uf_a".into());
        handle_register(&reg);

        set_signer("uf_b.near");
        reg.handle = Some("uf_b".into());
        handle_register(&reg);

        // Establish follow first
        set_signer("uf_a.near");
        let mut follow_req = test_request(Action::Follow);
        follow_req.handle = Some("uf_b".into());
        let resp = handle_follow(&follow_req);
        assert!(resp.success, "setup follow should succeed");

        // Snapshot state before attempted unfollow
        let before_target = load_agent("uf_b").unwrap();
        assert_eq!(before_target.follower_count, 1);
        assert!(has(&keys::pub_edge("uf_a", "uf_b")), "edge should exist before unfollow");
        let before_followers = index_list(&keys::pub_followers("uf_b"));
        assert_eq!(before_followers.len(), 1);

        // Inject write failures — save_agent in unfollow will fail,
        // triggering rollback of edge + indices (follow.rs:152-160)
        store::test_backend::fail_next_writes(10);

        let mut unfollow_req = test_request(Action::Unfollow);
        unfollow_req.handle = Some("uf_b".into());
        let resp = handle_unfollow(&unfollow_req);

        assert!(!resp.success, "unfollow should fail when storage fails");

        // Clear failure flag for reads
        store::test_backend::fail_next_writes(0);

        // Edge should be restored (rollback re-wrote it)
        assert!(has(&keys::pub_edge("uf_a", "uf_b")),
            "edge should be restored after failed unfollow");

        // Follower index should be restored
        let after_followers = index_list(&keys::pub_followers("uf_b"));
        assert_eq!(after_followers.len(), before_followers.len(),
            "follower index should be restored after failed unfollow");

        // Follower count should be unchanged
        let after_target = load_agent("uf_b").unwrap();
        assert_eq!(after_target.follower_count, before_target.follower_count,
            "follower count should not change on failed unfollow");
    }

    #[test]
    #[serial]
    fn integration_follow_partial_index_failure_rolls_back() {
        setup_integration("pi_a.near");
        let mut reg = test_request(Action::Register);
        reg.handle = Some("pi_a".into());
        handle_register(&reg);

        set_signer("pi_b.near");
        reg.handle = Some("pi_b".into());
        handle_register(&reg);

        // Snapshot
        let before_target = load_agent("pi_b").unwrap();

        // Inject exactly 3 failures: edge write + follower index succeed (2 writes
        // that happen to succeed because fail counter is checked inside set_worker),
        // but we inject enough to hit the index_append or save_agent stage.
        // With 3 failures the first write (edge) fails immediately.
        set_signer("pi_a.near");
        store::test_backend::fail_next_writes(3);

        let mut follow_req = test_request(Action::Follow);
        follow_req.handle = Some("pi_b".into());
        let resp = handle_follow(&follow_req);

        assert!(!resp.success, "follow should fail with injected write failures");

        // Clear failures
        store::test_backend::fail_next_writes(0);

        // Edge should not exist
        assert!(!has(&keys::pub_edge("pi_a", "pi_b")),
            "edge should not exist after failed follow");

        // Indices should be empty (no followers added)
        let followers = index_list(&keys::pub_followers("pi_b"));
        assert!(followers.is_empty(), "follower index should be empty after failed follow");

        let following = index_list(&keys::pub_following("pi_a"));
        assert!(following.is_empty(), "following index should be empty after failed follow");

        // Target count unchanged
        let after_target = load_agent("pi_b").unwrap();
        assert_eq!(after_target.follower_count, before_target.follower_count,
            "follower count should not change on failed follow");
    }

    // ── Suggestion diversity ──────────────────────────────────────────────

    #[test]
    fn diversify_caps_per_tag() {
        let mut rng = suggest::Rng::from_bytes(b"div");
        let limit = 6;

        // Create 10 agents all with tag "ai"
        let candidates: Vec<AgentRecord> = (0..10).map(|i| {
            let mut a = make_agent(&format!("mono_{i}"));
            a.tags = vec!["ai".into()];
            a.follower_count = 1;
            a
        }).collect();

        let visits: std::collections::HashMap<String, u32> = candidates.iter()
            .map(|a| (a.handle.clone(), 5)).collect();

        let ranked = suggest::rank_candidates(&mut rng, candidates, &visits, &[], limit);

        // Should return exactly limit items (cap + backfill)
        assert_eq!(ranked.len(), limit, "should return {limit} results");

        // First max_per_tag (limit/2 = 3) are within cap, rest are overflow backfill
        // The key invariant: we get results despite single-tag dominance
        assert!(ranked.len() > limit / 2,
            "diversify should backfill beyond the per-tag cap");
    }

    #[test]
    fn diversify_preserves_order_within_cap() {
        let mut rng = suggest::Rng::from_bytes(b"order");
        let limit = 4;

        // Agent with high visits + tag "ai"
        let mut a1 = make_agent("high_score");
        a1.tags = vec!["ai".into()];
        a1.follower_count = 1;

        // Agent with low visits + tag "defi"
        let mut a2 = make_agent("low_score");
        a2.tags = vec!["defi".into()];
        a2.follower_count = 1;

        let mut visits = std::collections::HashMap::new();
        visits.insert("high_score".to_string(), 50u32);
        visits.insert("low_score".to_string(), 1u32);

        let ranked = suggest::rank_candidates(&mut rng, vec![a1, a2], &visits, &[], limit);

        assert_eq!(ranked.len(), 2);
        assert_eq!(ranked[0].agent.handle, "high_score",
            "higher-scoring agent should come first");
    }

    // ── Suggestion integration (component-level) ──────────────────────────
    // Note: handle_get_suggested calls outlayer::vrf::random() which panics
    // outside WASI, so we test the wiring at component level instead.

    #[test]
    #[serial]
    fn integration_suggested_walks_graph_neighbors() {
        // A follows B, B follows C → random walk from A should visit C
        setup_integration("sug_a.near");
        let mut reg = test_request(Action::Register);
        reg.handle = Some("sug_a".into());
        reg.tags = Some(vec!["ai".into()]);
        handle_register(&reg);

        set_signer("sug_b.near");
        reg.handle = Some("sug_b".into());
        reg.tags = Some(vec!["ai".into()]);
        handle_register(&reg);

        set_signer("sug_c.near");
        reg.handle = Some("sug_c".into());
        reg.tags = Some(vec!["ai".into()]);
        handle_register(&reg);

        // B follows C
        set_signer("sug_b.near");
        let mut follow_req = test_request(Action::Follow);
        follow_req.handle = Some("sug_c".into());
        handle_follow(&follow_req);

        // A follows B
        set_signer("sug_a.near");
        follow_req.handle = Some("sug_b".into());
        handle_follow(&follow_req);

        // Replicate what handle_get_suggested does, minus VRF
        let follows = index_list(&keys::pub_following("sug_a"));
        let follow_set: std::collections::HashSet<String> = follows.iter().cloned().collect();
        let my_tags = load_agent("sug_a").unwrap().tags;

        let mut outgoing_cache: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
        let mut get_outgoing = |handle: &str| -> Vec<String> {
            if let Some(cached) = outgoing_cache.get(handle) { return cached.clone(); }
            let neighbors = index_list(&keys::pub_following(handle));
            outgoing_cache.insert(handle.to_string(), neighbors.clone());
            neighbors
        };

        let mut rng = suggest::Rng::from_bytes(b"test_seed");
        let visits = suggest::random_walk_visits(
            &mut rng, &follows, &follow_set, Some("sug_a"), &mut get_outgoing,
        );

        // C should be visited (reachable via A→B→C walk)
        assert!(visits.contains_key("sug_c"),
            "C should be visited via A→B→C walk, visits: {:?}", visits);

        // Score and rank
        let candidates = vec![load_agent("sug_c").unwrap()];
        let ranked = suggest::rank_candidates(&mut rng, candidates, &visits, &my_tags, 10);
        assert!(!ranked.is_empty(), "C should appear in ranked suggestions");
        assert_eq!(ranked[0].agent.handle, "sug_c");
    }
}
