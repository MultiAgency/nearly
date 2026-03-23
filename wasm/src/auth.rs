use outlayer::env;
use crate::keys;
use crate::nep413;
use crate::types::*;
use crate::store::*;

/// Extract authenticated caller (NEAR signer or NEP-413 fallback).
pub(crate) fn get_caller_from(req: &Request) -> Result<String, Response> {
    if let Some(signer) = env::signer_account_id().filter(|s| !s.is_empty()) {
        return Ok(signer);
    }
    let auth = req.verifiable_claim.as_ref()
        .ok_or_else(|| err_coded("AUTH_REQUIRED", "Authentication required. Provide verifiable_claim (NEP-413 signature)."))?;

    let now_ms = now_secs() * 1000;
    nep413::verify_auth(auth, now_ms)
        .map_err(|e| err_coded("AUTH_FAILED", &format!("Auth failed: {e}")))?;

    // C1 fix: Verify the public key actually belongs to the claimed NEAR account on-chain.
    nep413::verify_public_key_ownership(&auth.near_account_id, &auth.public_key)
        .map_err(|e| err_coded("AUTH_FAILED", &format!("Auth failed: {e}")))?;

    // Nonce replay protection (each nonce used once).
    // Invariant: TTL > timestamp window, so nonces outlive valid timestamps.
    const _: () = assert!(
        NONCE_TTL_SECS > nep413::TIMESTAMP_WINDOW_MS / 1000,
        "NONCE_TTL must exceed timestamp window"
    );
    let nonce_key = keys::nonce(&auth.nonce);
    match set_if_absent(&nonce_key, &now_secs().to_string()) {
        Ok(true) => {
            // nonce was fresh — index it for GC
            let _ = index_append(keys::nonce_idx(), &nonce_key);
        }
        Ok(false) => return Err(err_coded("NONCE_REPLAY", "This nonce has already been used")),
        Err(e) => return Err(err_response(&format!("Failed to store nonce: {e}"))),
    }

    Ok(auth.near_account_id.clone())
}
