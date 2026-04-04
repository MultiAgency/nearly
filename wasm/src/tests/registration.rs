use super::*;

#[test]
#[serial]
fn integration_register_creates_agent_in_storage() {
    setup_integration("alice.near");
    let req = RequestBuilder::new(Action::Register)
        .handle("alice")
        .description("Test agent")
        .tags(&["ai", "rust"])
        .build();

    let resp = handle_register(&req);
    assert!(resp.success, "register should succeed: {:?}", resp.error);

    let data = parse_response(&resp);
    assert_eq!(data["agent"]["handle"], "alice");
    assert_eq!(data["agent"]["description"], "Test agent");
    assert_eq!(data["near_account_id"], "alice.near");

    let agent = load_agent("alice").expect("agent should be in storage");
    assert_eq!(agent.handle, "alice");
    assert_eq!(agent.near_account_id, "alice.near");
    assert_eq!(agent.tags, vec!["ai", "rust"]);
}

#[test]
#[serial]
fn integration_register_rejects_duplicate_account() {
    setup_integration("bob.near");
    quick_register("bob.near", "bob");

    let req = RequestBuilder::new(Action::Register).handle("bob2").build();
    let resp2 = handle_register(&req);
    assert!(!resp2.success);
    assert_eq!(resp2.code.as_deref(), Some("ALREADY_REGISTERED"));
}

#[test]
#[serial]
fn integration_register_rejects_duplicate_handle() {
    setup_integration("carol.near");
    quick_register("carol.near", "shared_handle");

    let req = RequestBuilder::new(Action::Register)
        .handle("shared_handle")
        .build();
    set_signer("dave.near");
    let resp2 = handle_register(&req);
    assert!(!resp2.success);
    assert_eq!(resp2.code.as_deref(), Some("HANDLE_TAKEN"));
}

#[test]
fn format_agent_field_names_match_frontend_contract() {
    let mut agent = make_agent("alice");
    agent.description = "A test agent".to_string();
    agent.avatar_url = Some("https://example.com/alice.png".to_string());
    agent.tags = vec!["ai".to_string()];
    agent.capabilities = serde_json::json!({"skills": ["chat"]});
    agent.follower_count = 5;
    agent.following_count = 3;

    let json = format_agent(&agent);
    let obj = json
        .as_object()
        .expect("format_agent must return an object");

    let required_fields = [
        "handle",
        "description",
        "avatar_url",
        "tags",
        "capabilities",
        "endorsements",
        "platforms",
        "near_account_id",
        "follower_count",
        "following_count",
        "created_at",
        "last_active",
    ];
    for field in &required_fields {
        assert!(obj.contains_key(*field), "Missing field: {field}");
    }

    for key in obj.keys() {
        assert!(
            required_fields.contains(&key.as_str()),
            "Unexpected field: {key}"
        );
    }

    assert!(json["handle"].is_string());
    assert!(json["follower_count"].is_number());
    assert!(json["created_at"].is_number());
    assert!(json["tags"].is_array());
}

#[test]
#[serial]
fn integration_register_with_injected_failure_rolls_back() {
    setup_integration("regfail.near");

    store::test_backend::fail_next_writes(0);
    let mut req = test_request(Action::Register);
    req.handle = Some("regfail".into());

    store::test_backend::fail_next_writes(0);
    let resp = handle_register(&req);
    assert!(
        resp.success,
        "baseline register should succeed: {:?}",
        resp.error
    );

    set_signer("regfail2.near");
    store::test_backend::fail_next_writes(10);
    req.handle = Some("regfail2".into());
    let resp = handle_register(&req);
    assert!(
        !resp.success,
        "register should fail with injected write failures"
    );

    store::test_backend::fail_next_writes(0);

    assert!(
        load_agent("regfail2").is_none(),
        "agent should not exist after failed register"
    );

    assert!(
        agent_handle_for_account("regfail2.near").is_none(),
        "account mapping should not exist after failed register"
    );
}

#[test]
#[serial]
fn integration_register_rollback_cleans_registry() {
    setup_integration("regrb_a.near");
    quick_register("regrb_a.near", "regrb_a");

    set_signer("regrb_b.near");
    store::test_backend::fail_next_writes(10);
    let mut req = test_request(Action::Register);
    req.handle = Some("regrb_b".into());
    let resp = handle_register(&req);
    assert!(!resp.success, "register should fail with injected failures");
    store::test_backend::fail_next_writes(0);

    assert!(
        load_agent("regrb_b").is_none(),
        "failed registration should not create agent record"
    );

    assert!(
        agent_handle_for_account("regrb_b.near").is_none(),
        "failed registration should not create account mapping"
    );
}

#[test]
#[serial]
fn integration_register_partial_failure_after_mapping_saved() {
    setup_integration("rb2.near");

    store::test_backend::fail_after_writes(Some(1), 1);

    let req = RequestBuilder::new(Action::Register)
        .handle("rb2_agent")
        .build();
    let resp = handle_register(&req);

    assert!(!resp.success, "registration should fail");

    store::test_backend::fail_after_writes(None, 0);

    assert!(
        load_agent("rb2_agent").is_none(),
        "agent record should not exist"
    );
    assert!(
        agent_handle_for_account("rb2.near").is_none(),
        "stale mapping should be invisible via agent_handle_for_account"
    );
}

#[test]
#[serial]
fn integration_register_recovers_from_stale_mapping() {
    setup_integration("stale.near");

    store::test_backend::fail_after_writes(Some(1), 1);
    let req = RequestBuilder::new(Action::Register)
        .handle("stale_agent")
        .build();
    let resp = handle_register(&req);
    assert!(!resp.success, "first registration should fail");
    store::test_backend::fail_after_writes(None, 0);

    assert!(agent_handle_for_account("stale.near").is_none());
    assert!(load_agent("stale_agent").is_none());

    let req2 = RequestBuilder::new(Action::Register)
        .handle("stale_agent")
        .build();
    let resp2 = handle_register(&req2);
    assert!(
        resp2.success,
        "retry after stale mapping should succeed: {:?}",
        resp2.error
    );

    let agent = load_agent("stale_agent").expect("agent should exist after retry");
    assert_eq!(agent.near_account_id, "stale.near");
    assert_eq!(
        agent_handle_for_account("stale.near")
            .map(|(h, _)| h)
            .as_deref(),
        Some("stale_agent")
    );
}
