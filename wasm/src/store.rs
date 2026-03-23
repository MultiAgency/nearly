#[cfg(not(test))]
use outlayer::storage;
use serde::Serialize;

// ─── Test-only in-memory storage backend ─────────────────────────────────
#[cfg(test)]
pub(crate) mod test_backend {
    use std::cell::RefCell;
    use std::collections::HashMap;

    thread_local! {
        static STORE: RefCell<HashMap<String, Vec<u8>>> = RefCell::new(HashMap::new());
        static FAIL_NEXT: RefCell<u32> = RefCell::new(0);
    }

    pub fn clear() {
        STORE.with(|s| s.borrow_mut().clear());
        FAIL_NEXT.with(|f| *f.borrow_mut() = 0);
    }

    /// Make the next N write calls fail with a storage error.
    pub fn fail_next_writes(n: u32) {
        FAIL_NEXT.with(|f| *f.borrow_mut() = n);
    }

    pub fn set_worker(key: &str, value: &[u8]) -> Result<(), outlayer::storage::StorageError> {
        let should_fail = FAIL_NEXT.with(|f| {
            let mut count = f.borrow_mut();
            if *count > 0 { *count -= 1; true } else { false }
        });
        if should_fail {
            return Err(outlayer::storage::StorageError("injected test failure".into()));
        }
        STORE.with(|s| s.borrow_mut().insert(key.to_string(), value.to_vec()));
        Ok(())
    }

    pub fn set_worker_with_options(key: &str, value: &[u8], _is_encrypted: Option<bool>) -> Result<(), outlayer::storage::StorageError> {
        set_worker(key, value)
    }

    pub fn get_worker(key: &str) -> Result<Option<Vec<u8>>, outlayer::storage::StorageError> {
        Ok(STORE.with(|s| s.borrow().get(key).cloned()))
    }
}

// ─── Storage key constructors ─────────────────────────────────────────────
// All storage keys defined here for explicit, consistent schema.

pub mod keys {
    // ── Public social graph (public worker storage, readable by other agents)
    pub fn pub_agents() -> &'static str { "pub:agents" }
    pub fn pub_agent(handle: &str) -> String { format!("pub:agent:{handle}") }
    pub fn pub_followers(handle: &str) -> String { format!("pub:followers:{handle}") }
    pub fn pub_following(handle: &str) -> String { format!("pub:following:{handle}") }
    pub fn pub_edge(from: &str, to: &str) -> String { format!("pub:edge:{from}:follows:{to}") }
    pub fn pub_sorted(sort: &str) -> String { format!("pub:sorted:{sort}") }
    pub fn pub_meta_count() -> &'static str { "pub:meta:agent_count" }
    pub fn pub_meta_updated() -> &'static str { "pub:meta:last_updated" }

    // ── Private identity (private worker storage)
    pub fn near_account(account_id: &str) -> String { format!("near:{account_id}") }

    // ── Private audit trail (private worker storage)
    pub fn unfollowed(caller: &str, handle: &str, ts: u64) -> String { format!("unfollowed:{caller}:{handle}:{ts}") }
    pub fn unfollow_idx(handle: &str) -> String { format!("unfollow_idx:{handle}") }
    pub fn unfollow_idx_by(account: &str) -> String { format!("unfollow_idx_by:{account}") }

    // ── Private nonces (private worker storage)
    pub fn nonce(nonce_val: &str) -> String { format!("nonce:{nonce_val}") }
    pub fn nonce_idx() -> &'static str { "nonce_idx" }

    // ── Private suggestions (private worker storage)
    pub fn suggested(caller: &str, handle: &str, ts: u64) -> String { format!("suggested:{caller}:{handle}:{ts}") }
    pub fn suggested_idx(caller: &str) -> String { format!("suggested_idx:{caller}") }

    // ── Private notifications (private worker storage)
    pub fn notif(handle: &str, ts: u64, notif_type: &str, from: &str) -> String { format!("notif:{handle}:{ts}:{notif_type}:{from}") }
    pub fn notif_idx(handle: &str) -> String { format!("notif_idx:{handle}") }
    pub fn notif_read(handle: &str) -> String { format!("notif_read:{handle}") }
}

// ─── Storage dispatch (real or test backend) ─────────────────────────────

#[cfg(not(test))]
fn backend_set(key: &str, val: &[u8]) -> Result<(), String> {
    storage::set_worker(key, val).map_err(|e| e.to_string())
}

#[cfg(test)]
fn backend_set(key: &str, val: &[u8]) -> Result<(), String> {
    test_backend::set_worker(key, val).map_err(|e| e.to_string())
}

#[cfg(not(test))]
fn backend_get(key: &str) -> Result<Option<Vec<u8>>, String> {
    storage::get_worker(key).map_err(|e| e.to_string())
}

#[cfg(test)]
fn backend_get(key: &str) -> Result<Option<Vec<u8>>, String> {
    test_backend::get_worker(key).map_err(|e| e.to_string())
}

#[cfg(not(test))]
fn backend_set_public(key: &str, val: &[u8]) -> Result<(), String> {
    storage::set_worker_with_options(key, val, Some(false)).map_err(|e| e.to_string())
}

#[cfg(test)]
fn backend_set_public(key: &str, val: &[u8]) -> Result<(), String> {
    test_backend::set_worker_with_options(key, val, Some(false)).map_err(|e| e.to_string())
}

// ─── Worker storage helpers ──────────────────────────────────────────────

pub(crate) fn set_string(key: &str, val: &str) -> Result<(), String> {
    backend_set(key, val.as_bytes())
}

pub(crate) fn get_string(key: &str) -> Option<String> {
    backend_get(key)
        .ok()
        .flatten()
        .and_then(|b| if b.is_empty() { None } else { String::from_utf8(b).ok() })
}

pub(crate) fn set_json<T: Serialize>(key: &str, val: &T) -> Result<(), String> {
    let bytes = serde_json::to_vec(val).map_err(|e| e.to_string())?;
    backend_set(key, &bytes)
}

pub(crate) fn get_json<T: serde::de::DeserializeOwned>(key: &str) -> Option<T> {
    backend_get(key)
        .ok()
        .flatten()
        .filter(|b| !b.is_empty())
        .and_then(|b| serde_json::from_slice(&b).ok())
}

/// Write bytes to public (unencrypted) worker storage.
pub(crate) fn set_public(key: &str, val: &[u8]) -> Result<(), String> {
    backend_set_public(key, val)
}

pub(crate) fn has(key: &str) -> bool {
    backend_get(key)
        .ok()
        .flatten()
        .map(|b| !b.is_empty())
        .unwrap_or(false)
}

/// "Delete" by writing empty bytes (no true delete in OutLayer WIT).
/// Read helpers treat empty as absent. Best-effort; callers can check errors.
pub(crate) fn delete(key: &str) -> Result<(), String> {
    backend_set(key, &[]).map_err(|e| format!("Failed to delete key {key}: {e}"))
}

/// Atomically check-and-set a worker key. Returns Ok(true) if the key was
/// freshly created, Ok(false) if it already existed.
///
/// SAFETY: OutLayer serializes all WASM invocations for a given project —
/// there is no concurrent execution. This guarantee makes the read-then-write
/// pattern below equivalent to an atomic set-if-absent. If OutLayer ever
/// introduces concurrent execution, this MUST be replaced with a host-level
/// set_if_absent for worker storage (not currently in the WIT interface).
pub(crate) fn set_if_absent(key: &str, val: &str) -> Result<bool, String> {
    if get_string(key).is_some() {
        return Ok(false);
    }
    set_string(key, val)?;
    Ok(true)
}

// ─── Index helpers ───────────────────────────────────────────────────────
// Denormalized indices. "pub:" keys → public storage; others → private.

fn write_index<T: Serialize>(key: &str, val: &T) -> Result<(), String> {
    let bytes = serde_json::to_vec(val).map_err(|e| e.to_string())?;
    if key.starts_with("pub:") {
        backend_set_public(key, &bytes)
    } else {
        backend_set(key, &bytes)
    }
}

pub(crate) fn index_list(key: &str) -> Vec<String> {
    get_json::<Vec<String>>(key).unwrap_or_default()
}

pub(crate) fn index_append(key: &str, entry: &str) -> Result<(), String> {
    let mut idx = index_list(key);
    if !idx.iter().any(|e| e == entry) {
        idx.push(entry.to_string());
        write_index(key, &idx)?;
    }
    Ok(())
}

pub(crate) fn index_remove(key: &str, entry: &str) -> Result<(), String> {
    let mut idx = index_list(key);
    let before = idx.len();
    idx.retain(|e| e != entry);
    if idx.len() != before { write_index(key, &idx)?; }
    Ok(())
}

pub(crate) fn index_insert_sorted(key: &str, entry: &str) -> Result<(), String> {
    let mut idx = index_list(key);
    let pos = idx.binary_search_by(|e| e.as_str().cmp(entry)).unwrap_or_else(|p| p);
    if idx.get(pos).map(|e| e.as_str()) != Some(entry) {
        idx.insert(pos, entry.to_string());
        write_index(key, &idx)?;
    }
    Ok(())
}

pub(crate) fn index_remove_sorted(key: &str, entry: &str) -> Result<(), String> {
    let mut idx = index_list(key);
    if let Ok(pos) = idx.binary_search_by(|e| e.as_str().cmp(entry)) {
        idx.remove(pos);
        write_index(key, &idx)?;
    }
    Ok(())
}

// ─── Time & utility helpers ───────────────────────────────────────────────

pub(crate) fn now_secs() -> u64 {
    // Prefer block timestamp from the TEE execution environment
    if let Some(ns) = std::env::var("NEAR_BLOCK_TIMESTAMP")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
    {
        return ns / 1_000_000_000;
    }
    // Fallback to system time (dev/test only). Panic if unavailable —
    // ts=0 would poison nonce security (immediate GC enables replay).
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("System clock unavailable — cannot generate safe timestamps")
        .as_secs()
}

/// Extract timestamp from edge value (u64 or JSON `{"ts":...}`).
pub(crate) fn edge_timestamp(val: &str) -> Option<u64> {
    if let Ok(ts) = val.parse::<u64>() { return Some(ts); }
    serde_json::from_str::<serde_json::Value>(val).ok()
        .and_then(|v| v.get("ts")?.as_u64())
}

/// Prune index entries older than `cutoff`. Entries where `extract_ts` returns None are kept.
pub(crate) fn prune_index(index_key: &str, cutoff: u64, extract_ts: impl Fn(&str) -> Option<u64>) -> Result<(), String> {
    let keys: Vec<String> = get_json(index_key).unwrap_or_default();
    if keys.is_empty() { return Ok(()); }
    let mut retained = Vec::new();
    let mut expired = Vec::new();
    for key in &keys {
        if extract_ts(key).map(|ts| ts < cutoff).unwrap_or(false) {
            expired.push(key.clone());
        } else {
            retained.push(key.clone());
        }
    }
    if !expired.is_empty() {
        // Write index before deleting blobs — if the write fails, old blobs
        // remain reachable rather than becoming dangling references.
        set_json(index_key, &retained)
            .map_err(|e| format!("failed to prune index {index_key}: {e}"))?;
        for key in &expired {
            let _ = delete(key);
        }
    }
    Ok(())
}
