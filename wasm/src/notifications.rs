use crate::{get_json, get_string, set_json, set_string};

pub fn load_notif_index(handle: &str) -> Vec<String> {
    get_json::<Vec<String>>(&crate::keys::notif_idx(handle)).unwrap_or_default()
}

/// Max entries before inline pruning (safety cap vs 7-day heartbeat GC).
const MAX_NOTIF_INDEX: usize = 500;

pub fn append_notif(handle: &str, key: &str) -> Result<(), String> {
    let mut idx = load_notif_index(handle);
    idx.push(key.to_string());
    // Drop oldest if over cap (appended chronologically, front is oldest).
    let pruned: Vec<String> = if idx.len() > MAX_NOTIF_INDEX {
        let excess = idx.len() - MAX_NOTIF_INDEX;
        let old_keys = idx[..excess].to_vec();
        idx = idx[excess..].to_vec();
        old_keys
    } else {
        Vec::new()
    };
    // Write index before deleting blobs (prevents dangling refs on failure).
    set_json(&crate::keys::notif_idx(handle), &idx)?;
    for old_key in &pruned {
        let _ = crate::delete(old_key);
    }
    Ok(())
}

pub fn store_notification(
    target_handle: &str,
    notif_type: &str,
    from: &str,
    is_mutual: bool,
    ts: u64,
) -> Result<(), String> {
    if target_handle.is_empty() || from.is_empty() {
        return Err("notification skipped — empty target or sender".into());
    }
    let key = crate::keys::notif(target_handle, ts, notif_type, from);
    let val = serde_json::json!({
        "type": notif_type,
        "from": from,
        "is_mutual": is_mutual,
        "at": ts,
    });
    set_string(&key, &val.to_string())
        .map_err(|e| format!("failed to store notification: {e}"))?;
    if let Err(e) = append_notif(target_handle, &key) {
        let _ = crate::delete(&key); // clean up orphaned blob
        return Err(format!("failed to append notification index: {e}"));
    }
    Ok(())
}

pub fn load_notifications_since(handle: &str, since: u64) -> Vec<serde_json::Value> {
    load_notif_index(handle)
        .iter()
        .filter_map(|key| {
            let val = get_string(key)?;
            let parsed: serde_json::Value = serde_json::from_str(&val).ok()?;
            let at = parsed.get("at")?.as_u64()?;
            if at > since {
                Some(parsed)
            } else {
                None
            }
        })
        .collect()
}
