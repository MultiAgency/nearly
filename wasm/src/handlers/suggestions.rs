use std::collections::{HashMap, HashSet};
use crate::*;
use crate::follow::suggestion_reason;
use crate::registry::load_agents_sorted;

/// Build a deterministic-but-varying seed from caller + current timestamp.
/// Prevents identical suggestions across calls when VRF is unavailable.
fn caller_seed(caller: &str) -> Vec<u8> {
    let mut seed = caller.as_bytes().to_vec();
    seed.extend_from_slice(&now_secs().to_le_bytes());
    seed
}

pub fn handle_get_suggested(req: &Request) -> Response {
    let caller = require_caller!(req);
    let limit = req.limit.unwrap_or(10).min(50) as usize;

    // Seed RNG from VRF or deterministic fallback
    let vrf_result = outlayer::vrf::random("suggestions").ok();
    let rng_seed: Vec<u8> = if let Some(ref vr) = vrf_result {
        let hex = &vr.output_hex;
        if hex.len() >= 2 && hex.len() % 2 == 0 {
            let decoded: Result<Vec<u8>, _> = (0..hex.len() / 2)
                .map(|i| u8::from_str_radix(&hex[i*2..i*2+2], 16))
                .collect();
            decoded.unwrap_or_else(|_| caller_seed(&caller))
        } else {
            caller_seed(&caller)
        }
    } else {
        caller_seed(&caller)
    };
    let mut rng = suggest::Rng::from_bytes(&rng_seed);

    // Build caller context using handle-based indices
    let own_handle = agent_handle_for_account(&caller);
    let follows: Vec<String> = own_handle.as_ref()
        .map(|h| index_list(&keys::pub_following(h)))
        .unwrap_or_default();
    let follow_set: HashSet<String> = follows.iter().cloned().collect();
    let my_tags: Vec<String> = own_handle.as_ref()
        .and_then(|h| load_agent(h)).map(|a| a.tags).unwrap_or_default();

    // Build outgoing-edge cache for graph walks using handle-based indices
    let mut outgoing_cache: HashMap<String, Vec<String>> = HashMap::new();
    let mut get_outgoing = |handle: &str| -> Vec<String> {
        if let Some(cached) = outgoing_cache.get(handle) { return cached.clone(); }
        let neighbors = index_list(&keys::pub_following(handle));
        outgoing_cache.insert(handle.to_string(), neighbors.clone());
        neighbors
    };

    // Random walks + scoring
    let visits = suggest::random_walk_visits(
        &mut rng, &follows, &follow_set, own_handle.as_deref(), &mut get_outgoing,
    );

    // Load candidate agents (not already followed, not self).
    let candidate_limit = (limit * 5).max(50);
    let candidates: Vec<AgentRecord> = match load_agents_sorted(
        "followers",
        candidate_limit,
        &None,
        |a| !follow_set.contains(&a.handle) && own_handle.as_deref() != Some(a.handle.as_str()),
    ) {
        Ok((agents, _)) => agents,
        Err(_) => Vec::new(),
    };

    if candidates.is_empty() {
        return ok_response(serde_json::json!({ "agents": [], "vrf": null }));
    }

    let ranked = suggest::rank_candidates(&mut rng, candidates, &visits, &my_tags, limit);

    // Format results with suggestion reasons
    let ts = now_secs();
    let mut warnings: Vec<String> = Vec::new();
    let mut results: Vec<serde_json::Value> = Vec::with_capacity(limit);
    for s in ranked.into_iter().take(limit) {
        let v = visits.get(&s.agent.handle).copied().unwrap_or(0);
        let mut e = format_agent(&s.agent);
        e["is_following"] = serde_json::json!(false);
        e["reason"] = suggestion_reason(v, &s.shared_tags);

        let skey = keys::suggested(&caller, &s.agent.handle, ts);
        if let Err(e) = set_string(&skey, &format!("{v}")) {
            warnings.push(format!("suggestion audit: {e}"));
        } else {
            let _ = index_append(&keys::suggested_idx(&caller), &skey);
        }

        results.push(e);
    }

    let vrf_json = vrf_result.as_ref().map(|vr| serde_json::json!({
        "output": vr.output_hex, "proof": vr.signature_hex, "alpha": vr.alpha
    }));

    let mut resp = serde_json::json!({ "agents": results, "vrf": vrf_json });
    if !warnings.is_empty() { resp["warnings"] = serde_json::json!(warnings); }
    ok_response(resp)
}
